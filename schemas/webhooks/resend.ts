import { z } from "zod";
import { normaliseEmail } from "@/lib/email/suppression";

const resendEventDataSchema = z
  .object({
    email_id: z.string().optional(),
    to: z.union([z.array(z.string()), z.string()]).optional(),
    from: z.string().optional(),
    email: z.string().optional(),
    unsubscribed: z.boolean().optional(),
    bounce: z
      .object({
        type: z.string().optional(),
        subType: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

/**
 * Validated envelope for Resend Svix-signed webhook events across email delivery,
 * recipient suppression, contact lifecycle, and sending domain status updates.
 */
export const resendWebhookEventSchema = z
  .object({
    type: z.union([
      z.literal("email.sent"),
      z.literal("email.delivered"),
      z.literal("email.delivery_delayed"),
      z.literal("email.complained"),
      z.literal("email.bounced"),
      z.literal("email.opened"),
      z.literal("email.clicked"),
      z.literal("email.failed"),
      z.literal("email.scheduled"),
      z.literal("email.suppressed"),
      z.literal("email.received"),
      z.literal("domain.created"),
      z.literal("domain.updated"),
      z.literal("domain.deleted"),
      z.literal("contact.created"),
      z.literal("contact.updated"),
      z.literal("contact.deleted"),
      z.literal("contact.topics.updated"),
      z.string().min(1),
    ]),
    created_at: z.string().optional(),
    data: resendEventDataSchema.optional(),
  })
  .passthrough();

export type ResendWebhookEvent = z.infer<typeof resendWebhookEventSchema>;

/**
 * Returns every unique normalized recipient email across `data.to` and `data.email`.
 */
export function extractResendRecipients(event: ResendWebhookEvent): string[] {
  const rawList: string[] = [];
  const to = event.data?.to;
  if (typeof to === "string") {
    rawList.push(to);
  } else if (Array.isArray(to)) {
    rawList.push(...to);
  }
  if (typeof event.data?.email === "string") {
    rawList.push(event.data.email);
  }
  return [...new Set(rawList.map(normaliseEmail).filter(Boolean))];
}
