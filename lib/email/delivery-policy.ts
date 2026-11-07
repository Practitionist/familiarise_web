import type { Prisma } from "@prisma/client";
import type { PreferenceCategory } from "@/lib/novu/templates/types";
import { EMAIL_PREFERENCE_SELECT, isEmailAllowedForUser } from "./preferences";
import { normaliseEmail } from "./suppression";
import { isErasedRecipient } from "./erased-recipient";

/** The account a message was addressed to; a null category is a required notice. */
export interface EmailDeliveryPolicy {
  userId: string;
  category: PreferenceCategory | null;
}

/** The `FailedEmail` columns a policy is stored in. */
export interface EmailDeliveryColumns {
  deliveryUserId: string | null;
  deliveryCategory: PreferenceCategory | null;
}

export function deliveryColumns(
  policy: EmailDeliveryPolicy | undefined,
): EmailDeliveryColumns {
  return {
    deliveryUserId: policy?.userId ?? null,
    deliveryCategory: policy?.category ?? null,
  };
}

/** Null for direct-address mail, which has no account whose preferences apply. */
export function deliveryPolicyOf(
  row: EmailDeliveryColumns,
): EmailDeliveryPolicy | null {
  return row.deliveryUserId
    ? { userId: row.deliveryUserId, category: row.deliveryCategory }
    : null;
}

export const EMAIL_POLICY_USER_SELECT = {
  email: true,
  erasedAt: true,
  notificationPreferences: { select: EMAIL_PREFERENCE_SELECT },
} as const;

export type EmailPolicyUser = Prisma.UserGetPayload<{
  select: typeof EMAIL_POLICY_USER_SELECT;
}>;

/** Typed structurally so the relay's test store can satisfy it. */
export interface EmailPolicyReader {
  user: {
    findUnique(args: {
      where: { id: string };
      select: typeof EMAIL_POLICY_USER_SELECT;
    }): Promise<EmailPolicyUser | null>;
  };
}

export type EmailPolicyRefusal =
  | "recipient_missing"
  | "recipient_erased"
  | "recipient_changed"
  | "preference_changed";

/** The `lastError` of a message whose recipient's account was erased. */
export const RECIPIENT_ERASED_REFUSAL =
  `policy:${"recipient_erased" satisfies EmailPolicyRefusal}` as const;

/** Rereads the account now; a read failure throws so the caller leaves the row pending. */
export async function emailPolicyRefusal(
  policy: EmailDeliveryPolicy | null,
  recipient: string,
  db: EmailPolicyReader,
): Promise<EmailPolicyRefusal | null> {
  if (isErasedRecipient(recipient)) return "recipient_erased";
  if (!policy) return null;
  const user = await db.user.findUnique({
    where: { id: policy.userId },
    select: EMAIL_POLICY_USER_SELECT,
  });
  return emailPolicyRefusalForUser(policy, recipient, user);
}

/** Evaluates a policy against an account snapshot the caller already loaded. */
export function emailPolicyRefusalForUser(
  policy: EmailDeliveryPolicy,
  recipient: string,
  user: EmailPolicyUser | null,
): EmailPolicyRefusal | null {
  if (!user) return "recipient_missing";
  if (user.erasedAt) return "recipient_erased";
  if (!user.email || normaliseEmail(user.email) !== normaliseEmail(recipient)) {
    return "recipient_changed";
  }
  return isEmailAllowedForUser(user, policy.category)
    ? null
    : "preference_changed";
}

/** Thrown by `attempt()` in place of a send when the account no longer accepts the message. */
export class EmailPolicyRefusedError extends Error {
  constructor(public readonly reason: EmailPolicyRefusal) {
    super(`policy:${reason}`);
    this.name = "EmailPolicyRefusedError";
  }
}
