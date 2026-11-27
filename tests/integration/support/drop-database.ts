import type pg from "pg";

const sqlState = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

/**
 * Drop a test database.
 *
 * A plain DROP is tried first: PostgreSQL itself waits (up to five seconds) for sessions that
 * are just closing and stops an autovacuum worker on that database. `WITH (FORCE)` is only the
 * fallback for a session a test left open. It must not be the first choice: the test owner is
 * not a superuser, so it may not terminate a closing session of the runtime role or a
 * maintenance worker, and PostgreSQL then refuses the whole statement with "permission denied
 * to terminate process" — which made teardown fail at random although every test had passed.
 */
export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Unexpected test database name");
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"${attempt % 2 === 1 ? " WITH (FORCE)" : ""}`);
      return;
    } catch (error) {
      last = error;
      // 55006 object_in_use / 42501 insufficient_privilege: somebody is still connected.
      if (sqlState(error) !== "55006" && sqlState(error) !== "42501") throw error;
    }
  }
  throw last;
}
