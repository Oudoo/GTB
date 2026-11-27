/** Sandbox API credential and webhook contracts (API-01, EVT-01, document 04). */
import { z } from "zod";
import { safeText } from "./common";

export const CREDENTIAL_SCOPES = ["accounts:read", "payments:read", "payments:write", "batches:read", "collections:read", "agreements:read", "webhooks:manage"] as const;
export const WEBHOOK_EVENTS = ["payment.status_changed", "batch.finished", "deposit.posted", "limit.threshold_reached"] as const;

export const credentialCreateSchema = z.strictObject({
  name: safeText(3, 80),
  scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1).max(CREDENTIAL_SCOPES.length),
  accountIds: z.array(z.uuid()).max(20),
  expiresInDays: z.int().min(1).max(90),
});

export const webhookCreateSchema = z.strictObject({
  url: z.string().trim().min(10).max(2_000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});

export const deliveryListQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).optional() });
