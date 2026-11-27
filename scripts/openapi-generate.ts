/**
 * Write docs/api/openapi.json from the operation registry, or with --check fail when the
 * committed file differs from what the code declares.
 *   pnpm openapi:generate
 *   pnpm openapi:check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildOpenApi } from "../src/server/api/openapi";
import { API_VERSION } from "../src/server/api/operations/health";
import { ALL_OPERATIONS } from "../src/server/api/registry";

const target = new URL("../docs/api/openapi.json", import.meta.url);
const generated = `${JSON.stringify(buildOpenApi(ALL_OPERATIONS, API_VERSION), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    /* missing file is drift */
  }
  if (current !== generated) {
    console.error("docs/api/openapi.json is out of date. Run `pnpm openapi:generate`.");
    process.exit(1);
  }
  console.log(`OpenAPI is up to date (${ALL_OPERATIONS.length} operations).`);
} else {
  writeFileSync(target, generated);
  console.log(`Wrote docs/api/openapi.json (${ALL_OPERATIONS.length} operations).`);
}
