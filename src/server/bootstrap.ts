/**
 * Side-effect imports that register approval targets, instruction observers and job handlers.
 * The API registry pulls these in through its operation files; the worker, the seed and tests
 * import this module so the same registrations exist in every process.
 */
import "@/server/domain/admin/register";
import "@/server/domain/alerts/register";
import "@/server/domain/batches/register";
import "@/server/domain/collections/register";
import "@/server/domain/developer/register";
import "@/server/domain/operations/register";
import "@/server/domain/payroll/register";
import "@/server/domain/reports/register";
import "@/server/domain/agreements/rails";
import "@/server/domain/agreements/service";
import "@/server/domain/execution/jobs";
import "@/server/domain/payments/service";

export const BOOTSTRAPPED = true;
