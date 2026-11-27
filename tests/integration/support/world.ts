/**
 * A "world" is one isolated PostgreSQL database copied from the seeded template, plus helpers
 * that drive the REAL HTTP stack in-process: requests go through the same dispatcher as the
 * Next.js route (session cookie, same-origin/CSRF check, idempotency, If-Match, projections).
 * Actors authenticate with real credentials; no test injects an authorization context.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import "@/server/bootstrap";
import { dispatch } from "@/server/api/framework";
import { getRegistry } from "@/server/api/registry";
import { ManualClock } from "@/server/clock";
import { createDb, type Db } from "@/server/db/client";
import { makeDeps, type Deps, type RuntimeSettings } from "@/server/deps";
import { drainJobs } from "@/server/jobs/runner";
import { demoAgreementProposal } from "@/server/seed/demo";
import { CORPORATES, PEOPLE, TEST_NOW, type CorporateKey } from "@/server/seed/fixtures";

export const ORIGIN = "http://localhost:3000";
export const TEST_PASSWORD = "Synthetic-Test-Password-01";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export type ApiResult<T = unknown> = {
  status: number;
  headers: Headers;
  /** Parsed JSON body (`{ data, page?, correlationId }` or a problem document). */
  body: { data?: T; page?: { nextCursor: string | null; hasMore: boolean }; correlationId?: string; code?: string; [key: string]: unknown };
  data: T;
  text: string;
};

export type RequestOptions = {
  idempotencyKey?: string | null;
  ifMatch?: number | string | null;
  headers?: Record<string, string>;
  /** Omit the Origin and custom header a real same-origin fetch would send (CSRF tests). */
  forged?: boolean;
  form?: FormData;
};

export class Actor {
  cookie = "";
  bearer: string | null = null;

  constructor(
    private readonly world: World,
    readonly key: string,
  ) {}

  async request<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const headers = new Headers(options.headers ?? {});
    if (this.bearer) headers.set("authorization", `Bearer ${this.bearer}`);
    else if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET" && !options.forged && !this.bearer) {
      headers.set("origin", ORIGIN);
      headers.set("x-alqarib-request", "1");
    }
    if (method !== "GET" && options.idempotencyKey !== null) headers.set("idempotency-key", options.idempotencyKey ?? randomUUID());
    if (options.ifMatch !== undefined && options.ifMatch !== null) headers.set("if-match", `"${options.ifMatch}"`);
    let payload: BodyInit | undefined;
    if (options.form) {
      payload = options.form;
    } else if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    } else if (method !== "GET") {
      headers.set("content-type", "application/json");
    }
    const response = await dispatch(
      getRegistry(),
      new Request(`${ORIGIN}/api/v1${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) }),
      this.world.deps,
    );
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) {
      const jar = new Map(this.cookie.split("; ").filter(Boolean).map((pair) => [pair.split("=")[0] as string, pair]));
      for (const cookie of setCookies) {
        const pair = cookie.split(";")[0] as string;
        const name = pair.split("=")[0] as string;
        if (/Max-Age=0/i.test(cookie)) jar.delete(name);
        else jar.set(name, pair);
      }
      this.cookie = [...jar.values()].join("; ");
    }
    const text = await response.text();
    let parsed: ApiResult<T>["body"] = {};
    try {
      parsed = text ? (JSON.parse(text) as ApiResult<T>["body"]) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, headers: response.headers, body: parsed, data: parsed.data as T, text };
  }

  get<T = unknown>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, undefined, options);
  }
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, body, options);
  }
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PATCH", path, body, options);
  }
}

export class World {
  private readonly actors = new Map<string, Actor>();

  constructor(
    readonly name: string,
    readonly db: Db,
    readonly clock: ManualClock,
    readonly deps: Deps,
    readonly ownerUrl: string,
  ) {}

  /** A fresh, unauthenticated client. */
  anonymous(): Actor {
    return new Actor(this, "anonymous");
  }

  /** Sign in a seeded person with their real credentials (cached per world). */
  async as(key: string): Promise<Actor> {
    const cached = this.actors.get(key);
    if (cached) return cached;
    const actor = await this.signIn(key);
    this.actors.set(key, actor);
    return actor;
  }

  /** Always performs a new sign-in (a second browser session of the same person). */
  async signIn(key: string, password = TEST_PASSWORD): Promise<Actor> {
    const person = PEOPLE.find((entry) => entry.key === key);
    if (!person) throw new Error(`Unknown fixture person ${key}`);
    const actor = new Actor(this, key);
    const response = await actor.post("/session/login", { email: person.email, password }, { idempotencyKey: null });
    if (response.status !== 200) throw new Error(`Sign-in failed for ${key}: ${response.status} ${response.text}`);
    return actor;
  }

  /** Process every job that is due at the current (manual) clock. */
  drain(maxJobs = 500): Promise<number> {
    return drainJobs(this.deps, { maxJobs, workerId: `test-${this.name}` });
  }

  /** Activate a corporate's agreement through the real two-person bank governance flow. */
  async activateAgreement(corporate: CorporateKey = "A", overrides: Parameters<typeof demoAgreementProposal>[2] = {}): Promise<{ versionId: string }> {
    const maker = await this.as("bankMaker");
    const checker = await this.as("bankChecker");
    const proposed = await maker.post<{ version: { id: string; approvalRequestId: string } }>(
      `/bank/corporates/${CORPORATES[corporate].id}/agreement-proposals`,
      demoAgreementProposal(this.deps, corporate, overrides),
    );
    if (proposed.status !== 201) throw new Error(`Agreement proposal failed: ${proposed.status} ${proposed.text}`);
    const approvalId = proposed.data.version.approvalRequestId;
    const approval = await checker.get<{ version: number; targetRevision: number; payloadHash: string }>(`/approvals/${approvalId}`);
    const approved = await checker.post(
      `/approvals/${approvalId}/approve`,
      { proposalVersion: approval.data.targetRevision, proposalHash: approval.data.payloadHash },
      { ifMatch: approval.data.version },
    );
    if (approved.status !== 200) throw new Error(`Agreement approval failed: ${approved.status} ${approved.text}`);
    return { versionId: proposed.data.version.id };
  }

  /** Run a statement with the schema-owner role (privilege and fixture checks). */
  async ownerQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: this.ownerUrl });
    await client.connect();
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.end();
    }
  }

  async close(): Promise<void> {
    await this.db.$disconnect();
    const admin = new pg.Client({ connectionString: withDatabase(this.ownerUrl, "postgres") });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${this.name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}

export type WorldOptions = {
  now?: string;
  settings?: Partial<RuntimeSettings>;
  poolSize?: number;
};

/** Copy the seeded template into a new database and return a world bound to it. */
export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const ownerUrl = process.env["TEST_OWNER_URL"];
  const runtimeUrl = process.env["TEST_RUNTIME_URL"];
  const template = process.env["TEST_TEMPLATE_DB"];
  const prefix = process.env["TEST_DB_PREFIX"];
  if (!ownerUrl || !runtimeUrl || !template || !prefix) {
    throw new Error("Test database environment is missing: the PostgreSQL global setup did not run.");
  }
  const name = `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: withDatabase(ownerUrl, "postgres") });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }
  const db = createDb(withDatabase(runtimeUrl, name), { poolSize: options.poolSize ?? 24 });
  const clock = new ManualClock(options.now ?? TEST_NOW);
  const deps = makeDeps({
    db,
    clock,
    timeZone: "Africa/Tripoli",
    storagePath: `./storage/test/${name}`,
    appOrigin: ORIGIN,
    // Unknown outcomes are resolved explicitly in tests; no automatic inquiry races the assertions.
    settings: { autoInquiryDelaySeconds: 3600, settlementPollSeconds: 1, ...options.settings },
  });
  return new World(name, db, clock, deps, withDatabase(ownerUrl, name));
}

/** Release `count` prepared calls at the same instant and wait for all of them. */
export async function race<T>(calls: Array<() => Promise<T>>): Promise<T[]> {
  let open!: () => void;
  const barrier = new Promise<void>((resolve) => {
    open = resolve;
  });
  const running = calls.map(async (call) => {
    await barrier;
    return call();
  });
  open();
  return Promise.all(running);
}
