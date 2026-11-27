/**
 * `pnpm db:seed` — synthetic demo data for the SANDBOX only.
 *
 * Refuses to run unless APP_MODE=sandbox and SEED_DEMO_ENABLED=true, and requires a locally
 * generated DEMO_PASSWORD (never a shipped default). Safe to run twice: the second run creates
 * nothing and resets nothing.
 */
import { getDb } from "../src/server/db/client";
import { getDeps } from "../src/server/deps";
import { getEnv } from "../src/server/env";
import { seedDemo } from "../src/server/seed/demo";
import { EMAIL_DOMAIN, PEOPLE } from "../src/server/seed/fixtures";

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.seedDemoEnabled) {
    console.error("Refusing to seed: set SEED_DEMO_ENABLED=true in a sandbox environment.");
    process.exit(1);
  }
  if (!env.demoPassword || env.demoPassword.length < 12) {
    console.error("Refusing to seed: DEMO_PASSWORD must be set (at least 12 characters). Run `pnpm setup:env`.");
    process.exit(1);
  }
  const deps = await getDeps();
  const summary = await seedDemo(deps, { password: env.demoPassword });
  console.log(
    `Seed complete: ${summary.peopleCreated} identities created, ${summary.openingBalancesBooked} opening balances booked, ` +
      `Corporate B activated this run: ${summary.corporateBActivated}.`,
  );
  console.log(`${PEOPLE.length} synthetic identities exist under @${EMAIL_DOMAIN}. Their shared password is DEMO_PASSWORD in your private .env.`);
  await getDb(env.databaseUrl).$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seed failed");
  process.exit(1);
});
