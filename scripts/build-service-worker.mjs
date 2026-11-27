#!/usr/bin/env node
// Builds public/sw.js from the reviewed template and the explicit precache allowlist.
// Fails if an allowlisted file is missing from public/ or looks like a protected path.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const template = readFileSync(join(root, "src/pwa/sw.template.js"), "utf8");
const allowlist = JSON.parse(readFileSync(join(root, "src/pwa/precache-allowlist.json"), "utf8"));

const FORBIDDEN = [/^\/api\//, /^\/_next\//, /^\/(en|ar)(\/|$)/, /\.(json|csv|xlsx|pdf)$/i, /\?/];
for (const url of allowlist) {
  if (typeof url !== "string" || !url.startsWith("/")) throw new Error(`Invalid precache entry: ${url}`);
  if (FORBIDDEN.some((pattern) => pattern.test(url))) {
    throw new Error(`Precache entry is not an approved public static asset: ${url}`);
  }
  if (!existsSync(join(root, "public", url))) throw new Error(`Precache entry missing from public/: ${url}`);
}

function buildId() {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return `local-${Date.now().toString(36)}`;
  }
}

const id = buildId();
if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error("BUILD_ID contains unsupported characters");

// Each placeholder must occur exactly once, in code. A placeholder left behind (or one that
// was replaced inside a comment instead) would make the worker throw and never install.
for (const placeholder of ['"__BUILD_ID__"', "__PRECACHE__"]) {
  const occurrences = template.split(placeholder).length - 1;
  if (occurrences !== 1) throw new Error(`Service worker template must contain ${placeholder} exactly once (found ${occurrences})`);
}
const output = template.replace('"__BUILD_ID__"', JSON.stringify(id)).replace("__PRECACHE__", JSON.stringify(allowlist));
if (/__BUILD_ID__|__PRECACHE__/.test(output)) throw new Error("Service worker output still contains a placeholder");
// The generated file must at least parse as a script.
new Function(output);
writeFileSync(join(root, "public/sw.js"), output);
console.log(`Service worker built: build ${id}, ${allowlist.length} precached public files.`);
