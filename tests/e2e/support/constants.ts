/** Synthetic password given to every demo identity in the end-to-end database only. */
export const E2E_PASSWORD = "Synthetic-E2E-Password-01";
/** Document 07 fixture instant: Monday 2026-11-23 09:00 Africa/Tripoli. */
export const E2E_CLOCK_START = "2026-11-23T07:00:00.000Z";
export const EMAIL_DOMAIN = "demo.alqarib.test";

/** Distinct synthetic people used by the journeys (seeded by `src/server/seed/fixtures.ts`). */
export const ACTORS = {
  bankMaker: "bank.maker",
  bankChecker: "bank.checker",
  bankDual: "bank.dual",
  compliance: "compliance",
  ops: "ops",
  teller1: "teller1",
  manager1: "manager1",
  aAdmin: "a.admin",
  aAdmin2: "a.admin2",
  aMaker: "a.maker",
  aChecker1: "a.checker1",
  aChecker2: "a.checker2",
  aPayroll: "a.payroll",
  aTreasurer: "a.treasurer",
  aFinance: "a.finance",
  aViewer: "a.viewer",
  aDual: "a.dual",
  bMaker: "b.maker",
  bChecker: "b.checker",
} as const;

export type ActorKey = keyof typeof ACTORS;
