import type { Tx } from "./client";

/** Next value of a named, gap-tolerant reference sequence. Call inside the business transaction. */
export async function nextSequence(tx: Tx, scopeKey: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    INSERT INTO "ReferenceSequence" ("scopeKey", "nextValue") VALUES (${scopeKey}, 2)
    ON CONFLICT ("scopeKey") DO UPDATE SET "nextValue" = "ReferenceSequence"."nextValue" + 1
    RETURNING "nextValue" - 1 AS value`;
  return (rows[0] as { value: bigint }).value;
}
