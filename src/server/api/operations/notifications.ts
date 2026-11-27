/** In-app alerts and alert rules (S8, ALT-01). */
import { z } from "zod";
import { idParamSchema } from "@/contracts/common";
import { notificationListQuerySchema } from "@/contracts/reports";
import { getNotification, listAlertRules, listNotifications, markNotificationRead } from "@/server/domain/alerts/service";
import { command, query, type AnyOperation } from "../framework";

type IdParams = z.infer<typeof idParamSchema>;

export const notificationOperations: AnyOperation[] = [
  query<Record<string, never>, z.infer<typeof notificationListQuerySchema>>({
    id: "listNotifications",
    method: "GET",
    path: "/notifications",
    summary: "The caller's own in-app alerts in the current workspace",
    tag: "Alerts",
    scope: "any",
    query: notificationListQuerySchema,
    handler: async ({ deps, ctx, query: q }) => {
      const result = await listNotifications(deps, ctx, q);
      return { data: { items: result.items, unreadCount: result.unreadCount }, page: { nextCursor: result.nextCursor, hasMore: result.nextCursor !== null } };
    },
  }),
  command<IdParams>({
    id: "markNotificationRead",
    method: "POST",
    path: "/notifications/{id}/read",
    summary: "Mark one of the caller's own alerts as read",
    tag: "Alerts",
    scope: "any",
    params: idParamSchema,
    target: ({ params }) => ({ type: "notification", id: params.id }),
    execute: async ({ deps, ctx, params }) => markNotificationRead(deps, ctx, params.id),
    render: async ({ deps, ctx }, ref) => getNotification(deps, ctx, ref.id),
  }),
  query({
    id: "listAlertRules",
    method: "GET",
    path: "/alert-rules",
    summary: "Low-balance and limit-usage alert rules of the corporate",
    description: "Rules are seeded demo thresholds in this release; creating and editing them is a documented gap.",
    tag: "Alerts",
    scope: "corporate",
    permission: "alerts.read",
    handler: async ({ deps, ctx }) => ({ data: await listAlertRules(deps, ctx) }),
  }),
];
