/**
 * Authentication library integration (SEC-03, DEC-005).
 *
 * Better Auth provides credential verification, database-backed sessions and signed HttpOnly
 * cookies. This application deliberately does NOT mount the library's public HTTP handler:
 * sign-in, sign-out and session lookup are reached only through `/api/v1/session/*`, which add
 * the same-origin check, the per-identifier throttle and the "person/membership still active"
 * rule. There is no public sign-up, no password reset mailer and no "login as role" endpoint.
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { Db } from "@/server/db/client";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "./password";

export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const SESSION_REFRESH_SECONDS = 60 * 15;

export type AuthOptions = { db: Db; baseUrl: string; secret: string };

function build(options: AuthOptions) {
  const secure = options.baseUrl.startsWith("https://");
  return betterAuth({
    appName: "Al Qarib",
    baseURL: options.baseUrl,
    basePath: "/api/auth",
    secret: options.secret,
    trustedOrigins: [new URL(options.baseUrl).origin],
    database: prismaAdapter(options.db, { provider: "postgresql" }),
    user: {
      modelName: "person",
      additionalFields: {
        status: { type: "string", required: false, input: false },
        preferredLocale: { type: "string", required: false, input: false },
      },
    },
    session: {
      modelName: "authSession",
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      // No cookie cache: every request reads the session row, so deleting it revokes at once.
      cookieCache: { enabled: false },
      additionalFields: {
        activeMembershipId: { type: "string", required: false, input: false },
      },
    },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "authRateLimit",
      window: 60,
      max: 120,
    },
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "alqarib",
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure, path: "/" },
    },
    telemetry: { enabled: false },
    // Authentication outcomes are recorded as structured security events by the session
    // service; the library's own console logging is switched off.
    logger: { disabled: true },
  });
}

export type AuthInstance = ReturnType<typeof build>;

const instances = new WeakMap<Db, AuthInstance>();

/** One auth instance per database client (the app has one; tests have one per test database). */
export function getAuth(options: AuthOptions): AuthInstance {
  let instance = instances.get(options.db);
  if (!instance) {
    instance = build(options);
    instances.set(options.db, instance);
  }
  return instance;
}
