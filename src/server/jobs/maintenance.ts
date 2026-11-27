/**
 * Periodic housekeeping run by the worker between job claims. Every sweep is idempotent and
 * safe to run from several workers at once (each item is re-checked under a row lock).
 * Features add their own sweeps to `SWEEPS`.
 */
import type { Deps } from "@/server/deps";
import { promoteDueAgreementVersions } from "@/server/domain/agreements/service";
import { expireDueApprovals } from "@/server/domain/approvals/service";
import { logError, logInfo } from "@/server/logging";

export type Sweep = { name: string; run: (deps: Deps) => Promise<number> };

const SWEEPS: Sweep[] = [
  { name: "approvals.expire", run: (deps) => expireDueApprovals(deps) },
  { name: "agreements.promote", run: (deps) => promoteDueAgreementVersions(deps) },
];

export function registerSweep(sweep: Sweep): void {
  if (!SWEEPS.some((entry) => entry.name === sweep.name)) SWEEPS.push(sweep);
}

/** Run every sweep once. A failing sweep is logged and never stops the others. */
export async function runMaintenance(deps: Deps): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const sweep of SWEEPS) {
    try {
      const changed = await sweep.run(deps);
      result[sweep.name] = changed;
      if (changed > 0) logInfo("maintenance", "sweep changed records", { sweep: sweep.name, changed });
    } catch (error) {
      result[sweep.name] = -1;
      logError("maintenance", "sweep failed", error, { sweep: sweep.name });
    }
  }
  return result;
}
