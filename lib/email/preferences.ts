/**
 * #1653 — the email preference gate every lifecycle sender reads at send time.
 *
 * The gate reads `NotificationPreference` directly: Postgres is the only copy
 * of the flags, shared with the bell gate in `lib/novu/policy.ts`. A user with
 * no row has never changed anything and gets the defaults.
 */

import prisma, { type PrismaLike } from "@/lib/prisma";
import { DEFAULT_NOTIFICATION_TIMEZONE } from "@/lib/novu/humanize";
import type { PreferenceCategory } from "@/lib/novu/templates/types";
import { resolveViewerZone } from "@/lib/time/viewer-zone";
import { canSignLinks } from "@/lib/auth/link-signing";
import { buildEmailUnsubscribeUrl } from "./unsubscribe";

/** The nine per-category switches on `NotificationPreference`. */
export type EmailCategoryColumn =
  | "appointmentReminders"
  | "paymentNotifications"
  | "subscriptionAlerts"
  | "trialNotifications"
  | "supportUpdates"
  | "feedbackAlerts"
  | "orgBillingAlerts"
  | "orgMembershipAlerts"
  | "orgProgramAlerts";

/** Defined once: the email gate and the bell gate (`lib/novu/policy.ts`) both read this map. */
export const EMAIL_CATEGORY_COLUMN: Record<
  PreferenceCategory,
  EmailCategoryColumn
> = {
  appointments: "appointmentReminders",
  payments: "paymentNotifications",
  subscriptions: "subscriptionAlerts",
  trials: "trialNotifications",
  support: "supportUpdates",
  feedback: "feedbackAlerts",
  orgBilling: "orgBillingAlerts",
  orgMembership: "orgMembershipAlerts",
  orgProgram: "orgProgramAlerts",
};

export type EmailRecipient = {
  userId: string;
  /** The preference the message is gated on; null for a required notice. */
  category: PreferenceCategory | null;
  email: string;
  name: string | null;
  /** IANA zone every time in the message is rendered in. */
  zone: string;
  /** False when the user turned this category, or email, off. */
  allowed: boolean;
  /** Null for a required notice (`category === null`) or when links cannot be signed. */
  unsubscribeUrl: string | null;
};

type PreferenceRow = {
  allNotifications: boolean;
  emailEnabled: boolean;
} & Record<EmailCategoryColumn, boolean>;

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  timezone: string | null;
  erasedAt: Date | null;
  notificationPreferences: PreferenceRow | null;
};

type UserReader = Pick<PrismaLike, "user">;

export const EMAIL_PREFERENCE_SELECT = {
  allNotifications: true,
  emailEnabled: true,
  appointmentReminders: true,
  paymentNotifications: true,
  subscriptionAlerts: true,
  trialNotifications: true,
  supportUpdates: true,
  feedbackAlerts: true,
  orgBillingAlerts: true,
  orgMembershipAlerts: true,
  orgProgramAlerts: true,
} as const;

// A required notice (null category) ignores the switches; otherwise a missing
// row means defaults, and every default is on.
export function isEmailAllowedForUser(
  user: Pick<UserRow, "notificationPreferences">,
  category: PreferenceCategory | null,
): boolean {
  if (category === null) return true;
  const pref = user.notificationPreferences;
  if (!pref) return true;
  return (
    pref.allNotifications &&
    pref.emailEnabled &&
    pref[EMAIL_CATEGORY_COLUMN[category]] !== false
  );
}

async function fetchUsers(ids: string[], db: UserReader): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return db.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      email: true,
      name: true,
      timezone: true,
      erasedAt: true,
      notificationPreferences: { select: EMAIL_PREFERENCE_SELECT },
    },
  });
}

/**
 * One query for every recipient; an erased or address-less user is dropped,
 * and a recipient in `requiredFor` is allowed whatever their switches say.
 */
export async function loadEmailRecipients(
  userIds: string[],
  category: PreferenceCategory | null,
  db: UserReader = prisma,
  requiredFor: readonly string[] = [],
): Promise<EmailRecipient[]> {
  const ids = [...new Set(userIds)];
  const rows = await fetchUsers(ids, db);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const required = new Set(requiredFor);
  const signing = canSignLinks();

  return ids.flatMap((id) => {
    const user = byId.get(id);
    // An erased user receives nothing, a required notice included.
    if (!user?.email || user.erasedAt) return [];
    // A required send for this recipient is staged as a null-category notice.
    const effective = required.has(id) ? null : category;
    return [
      {
        userId: user.id,
        category: effective,
        email: user.email,
        name: user.name,
        zone: resolveViewerZone({
          userTimezone: user.timezone,
          fallbackZone: DEFAULT_NOTIFICATION_TIMEZONE,
        }),
        allowed: isEmailAllowedForUser(user, effective),
        unsubscribeUrl:
          effective !== null && signing
            ? buildEmailUnsubscribeUrl(user.id)
            : null,
      },
    ];
  });
}

/** The gate alone, for a caller that already holds the address. */
export async function isEmailAllowed(
  userId: string,
  category: PreferenceCategory | null,
  db: UserReader = prisma,
): Promise<boolean> {
  const [user] = await fetchUsers([userId], db);
  if (!user || user.erasedAt) return false;
  return isEmailAllowedForUser(user, category);
}
