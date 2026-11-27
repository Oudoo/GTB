/** Report request and alert contracts (RPT-01, ALT-01, document 04). */
import { z } from "zod";

export const REPORT_TYPES = ["STATEMENT", "DEPOSIT_SUMMARY"] as const;
export const REPORT_FORMATS = ["CSV", "PDF"] as const;

export const reportRequestSchema = z.strictObject({
  type: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS),
  accountIds: z.array(z.uuid()).min(1).max(10),
  fromDate: z.iso.date(),
  toDate: z.iso.date(),
  customerId: z.uuid().optional(),
  /** Language of headings in the file. */
  locale: z.enum(["en", "ar"]).optional(),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const notificationListQuerySchema = z.strictObject({
  unread: z.enum(["true", "false"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
