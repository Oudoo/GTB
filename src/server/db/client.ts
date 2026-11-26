/**
 * PostgreSQL access. One PrismaClient (one pool) per process, created from the least-privilege
 * runtime URL. Everything that must be atomic goes through `inTx`; adapter (core/rail/HTTP)
 * calls are never made while a platform transaction is open (document 03).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
/** Either the root client or an open transaction. */
export type DbOrTx = Db | Tx;

const globalStore = globalThis as unknown as { __alqaribDb?: Map<string, PrismaClient> };

export function createDb(connectionString: string, options: { poolSize?: number } = {}): Db {
  const adapter = new PrismaPg({ connectionString, max: options.poolSize ?? 12 });
  return new PrismaClient({ adapter });
}

/** Process-wide client for a connection string (survives Next.js dev hot reloads). */
export function getDb(connectionString: string | undefined = process.env["DATABASE_URL"]): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const store = (globalStore.__alqaribDb ??= new Map());
  let db = store.get(connectionString);
  if (!db) {
    db = createDb(connectionString);
    store.set(connectionString, db);
  }
  return db;
}

export async function disconnectAll(): Promise<void> {
  const store = globalStore.__alqaribDb;
  if (!store) return;
  await Promise.all([...store.values()].map((db) => db.$disconnect()));
  store.clear();
}

/** SQLSTATE of a database error, however the driver adapter wrapped it. */
export function sqlState(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ["originalCode", "sqlState", "code"]) {
      const value = record[key];
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) && !/^P\d{4}$/.test(value)) return value;
    }
    for (const key of ["cause", "meta", "driverAdapterError", "error"]) {
      if (record[key]) stack.push(record[key]);
    }
  }
  return undefined;
}

export function prismaCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return prismaCode(error) === "P2002" || sqlState(error) === "23505";
}

export function isExclusionViolation(error: unknown): boolean {
  return sqlState(error) === "23P01";
}

/** Serialization failure or deadlock: the transaction can be retried safely as a whole. */
export function isRetryableTxError(error: unknown): boolean {
  const state = sqlState(error);
  return state === "40001" || state === "40P01" || prismaCode(error) === "P2034";
}

export type TxOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  timeoutMs?: number;
  maxWaitMs?: number;
  /** Bounded retries for serialization failures/deadlocks (with jitter). */
  retries?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` in one transaction. Serialization failures and deadlocks retry the WHOLE function
 * a bounded number of times with jitter; anything else propagates and rolls back.
 */
export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const retries = options.retries ?? 4;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(fn, {
        maxWait: options.maxWaitMs ?? 15_000,
        timeout: options.timeoutMs ?? 30_000,
        ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      });
    } catch (error) {
      if (attempt >= retries || !isRetryableTxError(error)) throw error;
      await sleep(10 + Math.floor(Math.random() * 40) * (attempt + 1));
    }
  }
}

export { Prisma };
