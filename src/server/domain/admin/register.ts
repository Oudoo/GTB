/**
 * Corporate administration: approval target for user-change proposals.
 * Imported for its side effects by `src/server/bootstrap.ts` so the web app, the worker, the
 * seed and the tests all register the same handlers.
 */
import { registerApprovalTarget } from "@/server/domain/approvals/service";
import { userChangeApprovalTarget } from "./service";

registerApprovalTarget("userChange", userChangeApprovalTarget);
