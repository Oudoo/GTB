/**
 * Message catalogues. One JSON file per namespace and locale so features can be developed
 * independently. `tests/unit/i18n.test.ts` asserts that Arabic has exactly the same keys as
 * English — a missing translation is a failing test, not a silent English fallback.
 */
import arAdmin from "./ar/admin.json";
import arAlerts from "./ar/alerts.json";
import arAudit from "./ar/audit.json";
import arAuth from "./ar/auth.json";
import arBank from "./ar/bank.json";
import arBatches from "./ar/batches.json";
import arCollections from "./ar/collections.json";
import arCommon from "./ar/common.json";
import arCorp from "./ar/corp.json";
import arDeveloper from "./ar/developer.json";
import arErrors from "./ar/errors.json";
import arNav from "./ar/nav.json";
import arOps from "./ar/ops.json";
import arPayroll from "./ar/payroll.json";
import arReports from "./ar/reports.json";
import arStatus from "./ar/status.json";
import arTeller from "./ar/teller.json";
import arTypes from "./ar/types.json";
import enAdmin from "./en/admin.json";
import enAlerts from "./en/alerts.json";
import enAudit from "./en/audit.json";
import enAuth from "./en/auth.json";
import enBank from "./en/bank.json";
import enBatches from "./en/batches.json";
import enCollections from "./en/collections.json";
import enCommon from "./en/common.json";
import enCorp from "./en/corp.json";
import enDeveloper from "./en/developer.json";
import enErrors from "./en/errors.json";
import enNav from "./en/nav.json";
import enOps from "./en/ops.json";
import enPayroll from "./en/payroll.json";
import enReports from "./en/reports.json";
import enStatus from "./en/status.json";
import enTeller from "./en/teller.json";
import enTypes from "./en/types.json";

const en = {
  common: enCommon,
  errors: enErrors,
  status: enStatus,
  nav: enNav,
  auth: enAuth,
  types: enTypes,
  corp: enCorp,
  bank: enBank,
  audit: enAudit,
  admin: enAdmin,
  batches: enBatches,
  payroll: enPayroll,
  collections: enCollections,
  teller: enTeller,
  reports: enReports,
  ops: enOps,
  developer: enDeveloper,
  alerts: enAlerts,
};

const ar: typeof en = {
  common: arCommon,
  errors: arErrors,
  status: arStatus,
  nav: arNav,
  auth: arAuth,
  types: arTypes,
  corp: arCorp,
  bank: arBank,
  audit: arAudit,
  admin: arAdmin,
  batches: arBatches,
  payroll: arPayroll,
  collections: arCollections,
  teller: arTeller,
  reports: arReports,
  ops: arOps,
  developer: arDeveloper,
  alerts: arAlerts,
};

export const MESSAGES = { en, ar } as const;
export type Messages = typeof en;
