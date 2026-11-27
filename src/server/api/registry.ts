import { OperationRegistry, type AnyOperation } from "./framework";
import { approvalOperations } from "./operations/approvals";
import { auditOperations } from "./operations/audit";
import { dashboardOperations } from "./operations/dashboard";
import { agreementOperations, bankGovernanceOperations } from "./operations/governance";
import { healthOperations } from "./operations/health";
import { accountOperations, beneficiaryOperations, paymentOperations } from "./operations/payments";
import { sessionOperations } from "./operations/session";

/** Every `/api/v1` operation. A feature adds its own operations file and lists it here. */
export const ALL_OPERATIONS: readonly AnyOperation[] = [
  ...healthOperations,
  ...sessionOperations,
  ...dashboardOperations,
  ...accountOperations,
  ...beneficiaryOperations,
  ...paymentOperations,
  ...approvalOperations,
  ...agreementOperations,
  ...bankGovernanceOperations,
  ...auditOperations,
];

let registry: OperationRegistry | undefined;

export function getRegistry(): OperationRegistry {
  if (!registry) {
    registry = new OperationRegistry();
    registry.register(ALL_OPERATIONS);
  }
  return registry;
}
