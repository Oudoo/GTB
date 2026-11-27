#!/usr/bin/env node
// Creates a private local `.env` from `.env.example` with freshly generated secrets.
// It never prints secret values and never overwrites an existing `.env`.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const target = ".env";
if (existsSync(target)) {
  console.log("`.env` already exists — left untouched. Delete it first to regenerate.");
  process.exit(0);
}

const b64url = (n) => randomBytes(n).toString("base64url");
const ownerPassword = b64url(18);
const appPassword = b64url(18);
// Demo password: long, random, URL-safe; printed nowhere. Read it from `.env` when logging in.
const demoPassword = `Demo-${b64url(12)}`;

let text = readFileSync(".env.example", "utf8");
const set = (name, value) => {
  const re = new RegExp(`^${name}=.*$`, "m");
  if (!re.test(text)) throw new Error(`Variable ${name} missing from .env.example`);
  text = text.replace(re, `${name}=${value}`);
};

set("DATABASE_URL", `postgresql://alqarib_app:${appPassword}@127.0.0.1:5432/alqarib_dev`);
set(
  "MIGRATION_DATABASE_URL",
  `postgresql://alqarib_owner:${ownerPassword}@127.0.0.1:5432/alqarib_dev`,
);
set("AUTH_SECRET", b64url(48));
set("DATA_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
set("DEMO_PASSWORD", demoPassword);

writeFileSync(target, text, { mode: 0o600 });
chmodSync(target, 0o600);
console.log("Wrote .env with generated local secrets (mode 600). Values were not printed.");
console.log("Next: `pnpm db:local` (local cluster) or `docker compose up -d db`, then `pnpm db:migrate`.");
