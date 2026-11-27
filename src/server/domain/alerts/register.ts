/**
 * Alerts: rule evaluation sweep run by the worker between job claims.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 */
import { registerSweep } from "@/server/jobs/maintenance";
import { evaluateAlertRules } from "./service";

registerSweep({ name: "alerts.evaluate", run: (deps) => evaluateAlertRules(deps) });
