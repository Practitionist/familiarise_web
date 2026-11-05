import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { EMAIL_PREFERENCE_SELECT, isEmailAllowedForUser } from "./preferences";
import { normaliseEmail } from "./suppression";

export const emailDeliveryPolicySchema = z
  .object({
    userId: z.string().min(1),
    category: z
      .enum([
        "appointments",
        "payments",
        "subscriptions",
        "trials",
        "support",
        "feedback",
        "orgBilling",
        "orgMembership",
        "orgProgram",
      ])
      .nullable(),
  })
  .strict();

export type EmailDeliveryPolicy = z.infer<typeof emailDeliveryPolicySchema>;

const RECIPIENT_SELECT = {
  email: true,
  erasedAt: true,
  orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
  notificationPreferences: { select: EMAIL_PREFERENCE_SELECT },
} as const;

export interface EmailPolicyReader {
  user: {
    findUnique(args: {
      where: { id: string };
      select: typeof RECIPIENT_SELECT;
    }): Promise<Prisma.UserGetPayload<{
      select: typeof RECIPIENT_SELECT;
    }> | null>;
  };
}

export type EmailPolicyRefusal =
  | "invalid_policy"
  | "recipient_missing"
  | "recipient_erased"
  | "recipient_changed"
  | "preference_changed";

/** Rechecks the saved recipient context without inferring policy from rendered content. */
export async function emailPolicyRefusal(
  rawPolicy: unknown,
  recipient: string,
  db: EmailPolicyReader,
): Promise<EmailPolicyRefusal | null> {
  // Older rows and direct-address operational mail have no account policy context.
  if (rawPolicy === null || rawPolicy === undefined) return null;
  const parsed = emailDeliveryPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) return "invalid_policy";
  const user = await db.user.findUnique({
    where: { id: parsed.data.userId },
    select: RECIPIENT_SELECT,
  });
  if (!user) return "recipient_missing";
  if (user.erasedAt) return "recipient_erased";
  if (!user.email || normaliseEmail(user.email) !== normaliseEmail(recipient)) {
    return "recipient_changed";
  }
  return isEmailAllowedForUser(user, parsed.data.category)
    ? null
    : "preference_changed";
}

export class EmailPolicyRefusedError extends Error {
  constructor(public readonly reason: EmailPolicyRefusal) {
    super(`policy:${reason}`);
    this.name = "EmailPolicyRefusedError";
  }
}
