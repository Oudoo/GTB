/**
 * S5 bulk transfers (BAT-01..04; I-25, I-26, I-27, I-28): bounded upload, row validation in the
 * worker, explicit acceptance, one approval of the aggregate, one execution per row under its
 * own stable reference, partial results, and a retry that can never pay a row twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, bulkRecipientRef } from "@/server/seed/fixtures";
import { writeXlsx } from "@/server/files/xlsx";
import { accept, acceptSubmitApprove, bulkFile, bulkRow, getBatch, rowsOf, submit, upload, uploadAndValidate, type BatchData, type BulkRow } from "./support/batches";
import { approve, coreBalance, usage } from "./support/payments";
import { createWorld, race, type World } from "./support/world";

const OPERATING = ACCOUNTS.A_OPERATING.ref;
const ROW = 10_000n; // LYD 10.000
const FEE = 250n; // LYD 0.250 per row (module 2.1 tariff of the demo agreement)

/** Reserved value across every corporate-day window (the sandbox clock crosses midnight here). */
async function reservedAllDays(world: World): Promise<bigint> {
  const counters = await world.db.usageCounter.findMany({ where: { scopeKey: "CORPORATE", period: "DAY" } });
  return counters.reduce((sum, counter) => sum + counter.reservedMinor, 0n);
}

async function drainAll(world: World): Promise<void> {
  while ((await world.drain(2_000)) > 0) {
    /* until no job is due */
  }
}

describe("S5 bulk transfers", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await world.activateAgreement("A");
  });
  afterAll(async () => world.close());

  it("validates 100 rows, pays the accepted set once each, reports a partial result and retries only the failed row (I-25, I-27, I-28)", async () => {
    const rows: BulkRow[] = [];
    for (let n = 1; n <= 100; n += 1) rows.push(bulkRow(n));
    (rows[4] as BulkRow).amount = "ten";
    (rows[5] as BulkRow).amount = "10.0001";
    (rows[6] as BulkRow).account_reference = "DEMO-LY-999999";
    (rows[7] as BulkRow).beneficiary_name = "Entirely Different Holder";
    (rows[8] as BulkRow).row_reference = (rows[3] as BulkRow).row_reference;

    const maker = await world.as("aMaker");
    const balanceBefore = await coreBalance(world, OPERATING);
    const usageBefore = await usage(world);

    const uploaded = await upload(world, "aMaker", bulkFile(rows), { fileName: "november-suppliers.csv" });
    expect(uploaded.status).toBe(202);
    expect(uploaded.data).toMatchObject({ kind: "BULK", state: "VALIDATING", counts: { total: 100 } });
    expect(uploaded.data.reference).toMatch(/^BLK-[A-Z0-9]+-2026-\d{6}$/);
    // Nothing is checked or reserved in the request: the worker validates.
    expect(await world.db.batchRow.count({ where: { batchId: uploaded.data.id } })).toBe(0);
    await drainAll(world);

    let batch = await getBatch(world, uploaded.data.id, "aMaker");
    expect(batch.state).toBe("READY");
    expect(batch.counts).toMatchObject({ total: 100, valid: 95, invalid: 4, duplicate: 1, accepted: 0 });
    expect(batch.accepted).toBeNull();
    expect(batch.actions).toMatchObject({ accept: true, submit: false });

    const invalid = await rowsOf(world, batch.id, "aMaker", "INVALID");
    expect(invalid.projection).toBe("BULK");
    expect(invalid.items.map((row) => [row.lineNumber, row.validationState, row.errors?.[0]?.code])).toEqual([
      [6, "INVALID", "AMOUNT_FORMAT"],
      [7, "INVALID", "AMOUNT_DECIMALS"],
      [8, "INVALID", "ACCOUNT_NOT_FOUND"],
      [9, "INVALID", "NAME_MISMATCH"],
      [10, "DUPLICATE", "DUPLICATE_REFERENCE"],
    ]);
    const errorsFile = await maker.get(`/batches/${batch.id}/errors`);
    expect(errorsFile.status).toBe(200);
    expect(errorsFile.headers.get("content-type")).toContain("text/csv");
    expect(errorsFile.text).toContain("amount:AMOUNT_DECIMALS");
    expect(errorsFile.text.trim().split("\r\n")).toHaveLength(6);

    // Invalid rows are left out only with an explicit confirmation.
    const unconfirmed = await accept(world, "aMaker", batch);
    expect(unconfirmed.status).toBe(400);
    expect(JSON.stringify(unconfirmed.body)).toContain("confirmExcludeInvalid");
    // A stale review screen cannot confirm.
    const stale = await maker.post(`/batches/${batch.id}/accept-rows`, { validationVersion: batch.validationVersion + 1, confirmExcludeInvalid: true }, { ifMatch: batch.version });
    expect(stale.status).toBe(412);
    // An invalid row can never be smuggled into the accepted set.
    const smuggle = await maker.post(`/batches/${batch.id}/accept-rows`, { validationVersion: batch.validationVersion, confirmExcludeInvalid: true, excludedRowIds: [(invalid.items[0] as { id: string }).id] }, { ifMatch: batch.version });
    expect(smuggle.status).toBe(400);
    // Nobody but the uploader continues the batch; a checker has no write permission at all.
    expect((await accept(world, "aChecker1", batch, { confirmExcludeInvalid: true })).status).toBe(403);
    expect((await accept(world, "aDual", batch, { confirmExcludeInvalid: true })).status).toBe(403);

    const accepted = await accept(world, "aMaker", batch, { confirmExcludeInvalid: true });
    expect(accepted.status).toBe(200);
    batch = accepted.data;
    expect(batch.counts.accepted).toBe(95);
    expect(batch.accepted).toMatchObject({ amount: { minor: String(95n * ROW) }, fee: { minor: String(95n * FEE) }, totalDebit: { minor: String(95n * (ROW + FEE)) } });

    const submitted = await submit(world, "aMaker", batch);
    expect(submitted.status).toBe(202);
    batch = submitted.data;
    expect(batch.state).toBe("PENDING_APPROVAL");
    const approval = batch.approval as NonNullable<BatchData["approval"]>;
    expect(approval).toMatchObject({ state: "PENDING", requiredApprovals: 1 });
    expect(approval.summary).toMatchObject({ kind: "BULK", count: 95, amount: { minor: "950000" }, fee: { minor: "23750" }, totalDebit: { minor: "973750" } });
    // Submission reserves and debits nothing.
    expect(await coreBalance(world, OPERATING)).toBe(balanceBefore);
    expect((await usage(world)).reserved).toBe(usageBefore.reserved);

    // The maker cannot approve their own batch, even with a forged request.
    const self = await approve(world, approval.id, "aMaker");
    expect(self.status).toBe(403);
    const vote = await approve(world, approval.id, "aChecker1");
    expect(vote.status).toBe(200);
    batch = await getBatch(world, batch.id, "aMaker");
    expect(batch.state).toBe("APPROVED");
    // The whole total is reserved atomically at approval; nothing has been debited yet.
    expect((await usage(world)).reserved).toBe(usageBefore.reserved + 95n * ROW);
    expect(await coreBalance(world, OPERATING)).toBe(balanceBefore);

    await drainAll(world);
    batch = await getBatch(world, batch.id, "aMaker");
    expect(batch.state).toBe("PROCESSING");
    expect(batch.outcome).toMatchObject({ settled: 93, failed: 1, unknown: 1, returned: 0, inFlight: 0, settledAmount: { minor: String(93n * ROW) } });
    const failedRows = await rowsOf(world, batch.id, "aMaker", "FAILED");
    expect(failedRows.items.map((row) => [row.lineNumber, row.failureCode])).toEqual([[92, "BENEFICIARY_ACCOUNT_BLOCKED"]]);
    const unknownRows = await rowsOf(world, batch.id, "aMaker", "UNKNOWN");
    expect(unknownRows.items.map((row) => row.lineNumber)).toEqual([93]);

    // 93 settled rows and the booked-but-unanswered row left the account; the failed row did not.
    expect(await coreBalance(world, OPERATING)).toBe(balanceBefore - 94n * (ROW + FEE));
    expect(await usage(world)).toEqual({ consumed: usageBefore.consumed + 93n * ROW, reserved: usageBefore.reserved + ROW });

    // One instruction and one execution reference per accepted row.
    const instructions = await world.db.businessInstruction.findMany({ where: { batchId: batch.id }, include: { attempts: true } });
    expect(instructions).toHaveLength(95);
    expect(new Set(instructions.map((instruction) => instruction.businessKey)).size).toBe(95);
    expect(instructions.every((instruction) => instruction.attempts.length === 1)).toBe(true);
    expect(new Set(instructions.flatMap((instruction) => instruction.attempts.map((attempt) => attempt.executionReference))).size).toBe(95);

    // While a row is unknown the batch is not finished and nothing can be retried or cancelled.
    const early = await maker.post(`/batches/${batch.id}/retry`, {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("RETRY_NOT_ELIGIBLE");
    const cancelRunning = await maker.post(`/batches/${batch.id}/cancel`, { reason: "Trying to cancel a running batch" }, { ifMatch: batch.version });
    expect(cancelRunning.status).toBe(409);
    expect(cancelRunning.body.code).toBe("STATUS_UNRESOLVED");

    // Automatic inquiry by the stable reference finds the posting: no second debit.
    world.clock.advanceMs(61 * 60_000);
    await drainAll(world);
    batch = await getBatch(world, batch.id, "aMaker");
    expect(batch.state).toBe("PARTIALLY_COMPLETED");
    expect(batch.outcome).toMatchObject({ settled: 94, failed: 1, unknown: 0 });
    expect(await coreBalance(world, OPERATING)).toBe(balanceBefore - 94n * (ROW + FEE));
    expect(await usage(world)).toEqual({ consumed: usageBefore.consumed + 94n * ROW, reserved: usageBefore.reserved });
    expect(batch.timeline.map((event) => event.code)).toEqual(expect.arrayContaining(["BATCH_UPLOADED", "BATCH_VALIDATED", "BATCH_ROWS_ACCEPTED", "BATCH_SENT_FOR_APPROVAL", "BATCH_APPROVED", "BATCH_PROCESSING", "BATCH_PARTIALLY_COMPLETED"]));

    // Exactly one completion event and one notification, with aggregates only.
    const events = await world.db.outboxEvent.findMany({ where: { type: "batch.finished", corporateId: (instructions[0] as { corporateId: string }).corporateId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ resourceId: batch.id, reference: batch.reference, kind: "BULK", state: "PARTIALLY_COMPLETED", accepted: 95, settled: 94, failed: 1, unknown: 0 });
    expect(await world.db.notification.count({ where: { kind: "batch.finished", linkPath: `/batches/${batch.id}` } })).toBe(1);

    const result = await maker.get(`/batches/${batch.id}/result`);
    expect(result.status).toBe(200);
    const resultLines = result.text.trim().split("\r\n");
    expect(resultLines).toHaveLength(96);
    expect(resultLines.filter((line) => line.includes(",SETTLED,"))).toHaveLength(94);
    expect(resultLines.filter((line) => line.includes(",FAILED,BENEFICIARY_ACCOUNT_BLOCKED,"))).toHaveLength(1);

    // A settled row can never be retried.
    const settledRow = (await rowsOf(world, batch.id, "aMaker", "ACCEPTED")).items.find((row) => row.executionState === "SETTLED") as { id: string };
    const paidAgain = await maker.post(`/batches/${batch.id}/retry`, { rowIds: [settledRow.id] });
    expect(paidAgain.status).toBe(409);
    expect(paidAgain.body.code).toBe("RETRY_NOT_ELIGIBLE");

    // Two concurrent retries of the same failed row: exactly one new batch.
    const attempts = await race([() => maker.post<BatchData>(`/batches/${batch.id}/retry`, {}), () => maker.post<BatchData>(`/batches/${batch.id}/retry`, {})]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    const retry = (attempts.find((response) => response.status === 201) as { data: BatchData }).data;
    expect(retry).toMatchObject({ state: "READY", counts: { total: 1, valid: 1 }, parent: { id: batch.id } });
    expect(await world.db.batch.count({ where: { parentBatchId: batch.id } })).toBe(1);
    expect((await getBatch(world, batch.id, "aMaker")).retries.map((entry) => entry.id)).toEqual([retry.id]);

    // The other bank unblocked the recipient. The retry needs its own confirmation and approval.
    await world.db.simDirectoryAccount.update({ where: { scheme_reference: { scheme: "DEMO_DOMESTIC", reference: bulkRecipientRef(91) } }, data: { scenario: "SUCCESS" } });
    expect((await submit(world, "aMaker", retry)).status).toBe(400);
    const retried = await acceptSubmitApprove(world, "aMaker", retry);
    expect(retried.state).toBe("APPROVED");
    await drainAll(world);
    const finished = await getBatch(world, retry.id, "aMaker");
    expect(finished.state).toBe("COMPLETED");
    expect(finished.outcome).toMatchObject({ settled: 1, failed: 0 });

    // Same business instruction, a second attempt under its own reference; 95 debits in total.
    const retriedInstruction = await world.db.businessInstruction.findFirstOrThrow({ where: { businessKey: "BULK:R-091" }, include: { attempts: { orderBy: { attemptNo: "asc" } } } });
    expect(retriedInstruction.state).toBe("SETTLED");
    expect(retriedInstruction.attempts.map((attempt) => attempt.attemptNo)).toEqual([1, 2]);
    expect(retriedInstruction.attempts[1]?.executionReference).toBe((retriedInstruction.attempts[0]?.executionReference as string).replace(/A1$/, "A2"));
    expect(await world.db.businessInstruction.count({ where: { businessKey: { startsWith: "BULK:R-" } } })).toBe(95);
    expect(await coreBalance(world, OPERATING)).toBe(balanceBefore - 95n * (ROW + FEE));
    expect(await usage(world)).toEqual({ consumed: usageBefore.consumed + 95n * ROW, reserved: usageBefore.reserved });
    // The original batch keeps its own result; a finished retry cannot be retried again.
    expect((await maker.post(`/batches/${batch.id}/retry`, {})).status).toBe(409);
  });

  it("voids approvals when the accepted set changes and never releases a row set that differs from the approved digest (I-26)", async () => {
    const executeAt = new Date(world.clock.now().getTime() + 26 * 3_600_000).toISOString();
    const rows = [1, 2, 3].map((n) => bulkRow(n, {}, "SCH"));
    const review = await uploadAndValidate(world, "aMaker", bulkFile(rows), { executeAt, fileName: "scheduled.csv" });
    expect(review.counts.valid).toBe(3);
    const approved = await acceptSubmitApprove(world, "aMaker", review);
    expect(approved.state).toBe("SCHEDULED");
    const firstApproval = approved.approval as NonNullable<BatchData["approval"]>;
    // A future-dated batch reserves nothing until its business date.
    const reservedBefore = await reservedAllDays(world);
    expect(await world.db.businessInstruction.count({ where: { batchId: approved.id } })).toBe(0);

    // The maker removes a row after approval: revision changes, the votes are void.
    const all = await rowsOf(world, approved.id, "aMaker");
    const revised = await accept(world, "aMaker", approved, { excludedRowIds: [(all.items[2] as { id: string }).id] });
    expect(revised.status).toBe(200);
    expect(revised.data).toMatchObject({ state: "READY", revision: approved.revision + 1, counts: { accepted: 2 }, approval: null });
    // The earlier decision stays on record for the revision it was given on — and only that one.
    const old = await (await world.as("aChecker1")).get<{ state: string; targetRevision: number }>(`/approvals/${firstApproval.id}`);
    expect(old.data).toMatchObject({ state: "APPROVED", targetRevision: approved.revision });
    expect(await world.db.batch.findUniqueOrThrow({ where: { id: approved.id }, select: { approvalRequestId: true, revision: true } })).toEqual({ approvalRequestId: null, revision: approved.revision + 1 });
    // Nothing is released at the due time on the strength of that earlier decision.
    world.clock.advanceMs(27 * 3_600_000);
    await drainAll(world);
    expect((await getBatch(world, approved.id, "aMaker")).state).toBe("READY");
    expect(await world.db.businessInstruction.count({ where: { batchId: approved.id } })).toBe(0);
    expect(await reservedAllDays(world)).toBe(reservedBefore);

    // The scheduled time has passed: it is not reused silently.
    const passed = await submit(world, "aMaker", revised.data);
    expect(passed.status).toBe(422);
    expect(passed.body.code).toBe("EXECUTION_WINDOW_CLOSED");
    // Approved again under the new revision, for execution now.
    const resubmitted = await submit(world, "aMaker", revised.data, { acceptRolledExecution: true });
    expect(resubmitted.status).toBe(202);
    const secondApproval = resubmitted.data.approval as NonNullable<BatchData["approval"]>;
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(secondApproval.payloadHash).not.toBe(firstApproval.payloadHash);
    expect((await approve(world, secondApproval.id, "aChecker1")).status).toBe(200);
    expect(await reservedAllDays(world)).toBe(reservedBefore + 2n * ROW);

    // A stored row is altered behind the approval (defence in depth): the worker refuses.
    const target = await world.db.batchRow.findFirstOrThrow({ where: { batchId: approved.id, accepted: true }, orderBy: { lineNumber: "asc" } });
    await world.db.batchRow.update({ where: { id: target.id }, data: { amountMinor: 9_999_000n } });
    const balance = await coreBalance(world, OPERATING);
    await drainAll(world);
    const blocked = await getBatch(world, approved.id, "aMaker");
    expect(blocked).toMatchObject({ state: "APPROVED", releaseBlockCode: "REAPPROVAL_REQUIRED" });
    expect(blocked.timeline.map((event) => event.code)).toContain("RELEASE_BLOCKED");
    expect(await coreBalance(world, OPERATING)).toBe(balance);
    expect(await world.db.executionAttempt.count({ where: { instruction: { batchId: approved.id } } })).toBe(0);
    // The reservation taken at approval was handed back.
    expect(await reservedAllDays(world)).toBe(reservedBefore);

    // Asking for the release again re-checks everything and stays blocked.
    const again = await (await world.as("aMaker")).post(`/batches/${approved.id}/retry-release`, undefined, { ifMatch: blocked.version });
    expect(again.status).toBe(200);
    await drainAll(world);
    expect((await getBatch(world, approved.id, "aMaker")).releaseBlockCode).toBe("REAPPROVAL_REQUIRED");
    // The maker withdraws it; the references are free again.
    const current = await getBatch(world, approved.id, "aMaker");
    const cancelled = await (await world.as("aMaker")).post<BatchData>(`/batches/${approved.id}/cancel`, { reason: "Row set no longer matches the approval" }, { ifMatch: current.version });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.state).toBe("CANCELLED");
    expect(await world.db.batchRow.count({ where: { batchId: approved.id, activeBusinessKey: { not: null } } })).toBe(0);
  });

  it("rejects duplicates of business references, oversized and unsafe files before anything is queued (I-25, I-27)", async () => {
    const maker = await world.as("aMaker");
    // The same business references under a different file name: nothing is payable twice.
    const again = await uploadAndValidate(world, "aMaker", bulkFile([1, 2, 3].map((n) => bulkRow(n))), { fileName: "renamed-copy.csv" });
    expect(again).toMatchObject({ state: "FAILED", validationErrorCode: "NO_VALID_ROWS", counts: { valid: 0, duplicate: 3 } });
    const duplicateRows = await rowsOf(world, again.id, "aMaker");
    expect(duplicateRows.items.every((row) => row.errors?.[0]?.code === "DUPLICATE_BUSINESS_REFERENCE")).toBe(true);
    expect(await world.db.businessInstruction.count({ where: { batchId: again.id } })).toBe(0);

    // The identical file is flagged against the earlier upload.
    const bytes = bulkFile([1, 2].map((n) => bulkRow(n, {}, "IDN")));
    const first = await uploadAndValidate(world, "aMaker", bytes, { fileName: "identical.csv" });
    const second = await uploadAndValidate(world, "aMaker", bytes, { fileName: "identical-again.csv" });
    expect(second.identicalTo).toEqual({ id: first.id, reference: first.reference });
    // Whichever is confirmed first carries the references; the other can no longer be confirmed.
    expect((await accept(world, "aMaker", first)).status).toBe(200);
    const clash = await accept(world, "aMaker", second);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("DUPLICATE_RESOURCE");
    for (const entry of [first, second]) {
      const current = await getBatch(world, entry.id, "aMaker");
      expect((await maker.post(`/batches/${entry.id}/cancel`, { reason: "Identical-file fixture finished" }, { ifMatch: current.version })).status).toBe(200);
    }

    const before = await world.db.batch.count();
    // One row more than the agreement allows.
    const tooMany = await upload(world, "aMaker", bulkFile(Array.from({ length: 101 }, (_, index) => bulkRow((index % 100) + 1, { row_reference: `CAP-${index}` }))));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe("BATCH_ROW_CAP_EXCEEDED");
    // A formula in a workbook, a workbook renamed to .csv, an unknown column, an empty file.
    const workbook = (await import("fflate")).zipSync({
      "[Content_Types].xml": new TextEncoder().encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
      "xl/workbook.xml": new TextEncoder().encode('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": new TextEncoder().encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/worksheets/sheet1.xml": new TextEncoder().encode('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'),
    });
    const formula = await upload(world, "aMaker", workbook, { fileName: "formula.xlsx" });
    expect(formula.status).toBe(400);
    expect(JSON.stringify(formula.body)).toContain("FORMULA");
    const disguised = await upload(world, "aMaker", writeXlsx([{ name: "Data", rows: [["a"]] }]), { fileName: "really-a-workbook.csv" });
    expect([400, 415]).toContain(disguised.status);
    const unknownColumn = await upload(world, "aMaker", new TextEncoder().encode(`row_reference,beneficiary_name,account_scheme,account_reference,amount,currency,purpose,salary\r\nX-1,A,DEMO_DOMESTIC,${bulkRecipientRef(1)},1.000,LYD,p,1\r\n`));
    expect(unknownColumn.status).toBe(400);
    expect(JSON.stringify(unknownColumn.body)).toContain("UNEXPECTED_HEADER");
    const empty = await upload(world, "aMaker", new TextEncoder().encode("row_reference,beneficiary_name,account_scheme,account_reference,amount,currency,purpose\r\n"));
    expect(empty.status).toBe(400);
    const executable = await upload(world, "aMaker", bulkFile([bulkRow(1, {}, "EXE")]), { fileName: "rows.exe" });
    expect(executable.status).toBe(415);
    const wrongTemplate = await upload(world, "aMaker", bulkFile([bulkRow(1, {}, "TPL")]), { templateVersion: 2 });
    expect([400, 415]).toContain(wrongTemplate.status);
    // None of the refused uploads left a batch, a row or a job behind.
    expect(await world.db.batch.count()).toBe(before);

    // A valid workbook is accepted like a CSV.
    const xlsx = await uploadAndValidate(world, "aMaker", bulkFile([bulkRow(4, {}, "XLS"), bulkRow(5, {}, "XLS")], "xlsx"), { fileName: "suppliers.xlsx" });
    expect(xlsx).toMatchObject({ state: "READY", counts: { total: 2, valid: 2 } });
    const cancelled = await maker.post<BatchData>(`/batches/${xlsx.id}/cancel`, { reason: "Uploaded for the format check only" }, { ifMatch: xlsx.version });
    expect(cancelled.data.state).toBe("CANCELLED");
    // An upload replayed with the same idempotency key creates one batch.
    const key = crypto.randomUUID();
    const replayBytes = bulkFile([bulkRow(6, {}, "RPL")]);
    const one = await upload(world, "aMaker", replayBytes, { idempotencyKey: key, fileName: "replay.csv" });
    const two = await upload(world, "aMaker", replayBytes, { idempotencyKey: key, fileName: "replay.csv" });
    expect([one.status, two.status]).toEqual([202, 202]);
    expect(two.data.id).toBe(one.data.id);
    expect(await world.db.batch.count({ where: { fileName: "replay.csv" } })).toBe(1);
  });

  it("enforces permissions, tenant isolation, account rights and limits on the server (SEC-01, LIM-01..03)", async () => {
    const file = bulkFile([bulkRow(10, {}, "PRM"), bulkRow(11, {}, "PRM")]);
    // No create permission, no debit right, no agreement, wrong corporate.
    expect((await upload(world, "aViewer", file)).status).toBe(403);
    expect((await upload(world, "aChecker1", file)).status).toBe(403);
    expect((await upload(world, "aMaker", file, { source: "A_PAYROLL" })).status).toBe(403);
    const otherTenantAccount = await upload(world, "bMaker", file, { source: "A_OPERATING" });
    expect([403, 404]).toContain(otherTenantAccount.status);
    const noAgreement = await upload(world, "cMaker", file, { source: "C_OPERATING" as never });
    expect(noAgreement.status).toBe(422);
    expect(noAgreement.body.code).toBe("AGREEMENT_INACTIVE");
    // Cross-site and replayed-origin requests are refused before any parsing.
    const forged = new FormData();
    forged.set("kind", "BULK");
    expect((await (await world.as("aMaker")).post("/batches/uploads", undefined, { form: forged, forged: true })).status).toBe(403);

    const batch = await uploadAndValidate(world, "aMaker", file, { fileName: "permissions.csv" });
    expect(batch.state).toBe("READY");
    // Another corporate cannot see, list, read rows of, download or act on the batch.
    const outsider = await world.as("bMaker");
    for (const path of [`/batches/${batch.id}`, `/batches/${batch.id}/rows`, `/batches/${batch.id}/errors`, `/batches/${batch.id}/result`]) expect((await outsider.get(path)).status).toBe(404);
    expect((await outsider.post(`/batches/${batch.id}/accept-rows`, { validationVersion: batch.validationVersion }, { ifMatch: batch.version })).status).toBe(404);
    expect((await outsider.post(`/batches/${batch.id}/cancel`, { reason: "Not my batch at all" }, { ifMatch: batch.version })).status).toBe(404);
    expect(((await outsider.get<BatchData[]>("/batches")).data ?? []).some((entry) => entry.id === batch.id)).toBe(false);
    // A viewer of the same corporate reads the summary but cannot change it.
    const viewer = await world.as("aViewer");
    expect((await viewer.get<BatchData>(`/batches/${batch.id}`)).data.actions).toMatchObject({ accept: false, submit: false, cancel: false });
    expect((await viewer.post(`/batches/${batch.id}/cancel`, { reason: "Viewer cannot cancel" }, { ifMatch: batch.version })).status).toBe(403);
    // Bank staff have no corporate batch access.
    expect((await (await world.as("ops")).get(`/batches/${batch.id}`)).status).toBe(404);
    await (await world.as("aMaker")).post(`/batches/${batch.id}/cancel`, { reason: "Permission fixture finished" }, { ifMatch: batch.version });

    // Per-item ceilings mark the row; they are not silently capped.
    const limits = await uploadAndValidate(world, "aMaker", bulkFile([bulkRow(12, { amount: "3000.001" }, "LIM"), bulkRow(13, { amount: "2900.000" }, "LIM"), bulkRow(14, { amount: "2900.000" }, "LIM"), bulkRow(15, { amount: "2900.000" }, "LIM"), bulkRow(16, { amount: "2900.000" }, "LIM")]), { fileName: "limits.csv" });
    expect(limits.counts).toMatchObject({ valid: 4, invalid: 1 });
    const overItem = (await rowsOf(world, limits.id, "aMaker", "INVALID")).items[0];
    expect(overItem?.errors?.[0]).toMatchObject({ code: "ITEM_LIMIT_EXCEEDED", field: "amount" });
    // 4 × 2,900 is above the maker's daily limit: refused at submission, nothing reserved.
    const reservedBefore = (await usage(world)).reserved;
    const acceptedLimits = await accept(world, "aMaker", limits, { confirmExcludeInvalid: true });
    expect(acceptedLimits.status).toBe(200);
    const refused = await submit(world, "aMaker", acceptedLimits.data);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("USER_LIMIT_EXCEEDED");
    expect((await getBatch(world, limits.id, "aMaker")).state).toBe("READY");
    expect((await usage(world)).reserved).toBe(reservedBefore);
    expect(await world.db.approvalRequest.count({ where: { targetType: "batch", targetId: limits.id } })).toBe(0);
  });
});
