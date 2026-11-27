#!/usr/bin/env node
// Bundles worker/index.ts into dist/worker/index.mjs for `pnpm worker:start`.
// Application code is bundled; npm dependencies stay external and are resolved from
// node_modules at run time (native modules such as @node-rs/argon2 cannot be bundled).
import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist/worker");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["worker/index.ts"],
  outfile: "dist/worker/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  packages: "external",
  // `server-only` is a Next.js build-time guard with no meaning in a plain Node process.
  alias: { "@": resolve(root, "src"), "server-only": resolve(root, "tests/stubs/server-only.ts") },
  tsconfig: resolve(root, "tsconfig.json"),
  logLevel: "warning",
});
console.log("Worker built: dist/worker/index.mjs");
