/**
 * Developer surface (S9): sandbox API credentials and webhooks. Managing them needs a human
 * administrator who also holds the API role; a bearer token can read webhook configuration
 * (scope webhooks:manage) but can never create a token, widen scopes or read a secret.
 */
import { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import { credentialCreateSchema, deliveryListQuerySchema, webhookCreateSchema } from "@/contracts/developer";
import { createCredential, createWebhook, disableWebhook, getCredential, getWebhook, listCredentials, listDeliveries, listWebhooks, revokeCredential } from "@/server/domain/developer/service";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const developerOperations: AnyOperation[] = [
  query({
    id: "listCredentials",
    method: "GET",
    path: "/developer/credentials",
    summary: "Sandbox API credentials (metadata only)",
    description: "The token itself is shown once at creation and is not stored.",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.read",
    handler: async ({ deps, ctx }) => ({ data: await listCredentials(deps, ctx) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof credentialCreateSchema>>({
    id: "createCredential",
    method: "POST",
    path: "/developer/credentials",
    summary: "Create a sandbox bearer token with explicit scopes and accounts",
    description: "The response of this request contains `token` exactly once. A credential cannot approve, administer access, reach bank operations or read payroll detail.",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.manage",
    body: credentialCreateSchema,
    successStatus: 201,
    execute: async ({ deps, ctx, body, newId }) => createCredential(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getCredential(deps, ctx, ref.id),
  }),
  command<IdParams>({
    id: "revokeCredential",
    method: "POST",
    path: "/developer/credentials/{id}/revoke",
    summary: "Revoke a token immediately",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.manage",
    params: idParamSchema,
    target: ({ params }) => ({ type: "apiCredential", id: params.id }),
    execute: async ({ deps, ctx, params }) => revokeCredential(deps, ctx, params.id),
    render: async ({ deps, ctx }, ref) => getCredential(deps, ctx, ref.id),
  }),
  query({
    id: "listWebhooks",
    method: "GET",
    path: "/developer/webhooks",
    summary: "Webhook subscriptions",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.read",
    credentialScope: "webhooks:manage",
    handler: async ({ deps, ctx }) => ({ data: await listWebhooks(deps, ctx) }),
  }),
  command<Record<string, never>, Record<string, never>, z.infer<typeof webhookCreateSchema>>({
    id: "createWebhook",
    method: "POST",
    path: "/developer/webhooks",
    summary: "Subscribe an HTTPS destination to events",
    description: "The destination must pass the SSRF policy (public HTTPS host, default port, no credentials). The response contains `signingSecret` exactly once. No request is sent to verify the destination.",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.manage",
    body: webhookCreateSchema,
    successStatus: 201,
    execute: async ({ deps, ctx, body, newId }) => createWebhook(deps, ctx, body, newId),
    render: async ({ deps, ctx }, ref) => getWebhook(deps, ctx, ref.id),
  }),
  command<IdParams>({
    id: "disableWebhook",
    method: "POST",
    path: "/developer/webhooks/{id}/disable",
    summary: "Stop deliveries to a subscription",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.manage",
    params: idParamSchema,
    ifMatch: true,
    target: ({ params }) => ({ type: "webhookSubscription", id: params.id }),
    execute: async ({ deps, ctx, params, expectedVersion }) => disableWebhook(deps, ctx, params.id, expectedVersion),
    render: async ({ deps, ctx }, ref) => getWebhook(deps, ctx, ref.id),
  }),
  query<IdParams, z.infer<typeof deliveryListQuerySchema>>({
    id: "listWebhookDeliveries",
    method: "GET",
    path: "/developer/webhooks/{id}/deliveries",
    summary: "Sanitized delivery log of one subscription",
    description: "Outcome codes, HTTP status and attempt counts. Never payloads or response bodies.",
    tag: "Developer",
    scope: "corporate",
    permission: "developer.read",
    credentialScope: "webhooks:manage",
    params: idParamSchema,
    query: deliveryListQuerySchema,
    handler: async ({ deps, ctx, params, query: q }) => ({ data: await listDeliveries(deps, ctx, params.id, q.limit) }),
  }),
];
