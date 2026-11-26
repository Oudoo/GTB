/**
 * Message catalogues. One JSON file per namespace and locale so features can be developed
 * independently. `tests/unit/i18n.test.ts` asserts that Arabic has exactly the same keys as
 * English — a missing translation is a failing test, not a silent English fallback.
 */
import arAuth from "./ar/auth.json";
import arCommon from "./ar/common.json";
import arErrors from "./ar/errors.json";
import arNav from "./ar/nav.json";
import arStatus from "./ar/status.json";
import enAuth from "./en/auth.json";
import enCommon from "./en/common.json";
import enErrors from "./en/errors.json";
import enNav from "./en/nav.json";
import enStatus from "./en/status.json";

const en = {
  common: enCommon,
  errors: enErrors,
  status: enStatus,
  nav: enNav,
  auth: enAuth,
};

const ar: typeof en = {
  common: arCommon,
  errors: arErrors,
  status: arStatus,
  nav: arNav,
  auth: arAuth,
};

export const MESSAGES = { en, ar } as const;
export type Messages = typeof en;
