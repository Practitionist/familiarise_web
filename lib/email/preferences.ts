/**
 * #1653 — the email preference gate every lifecycle sender reads at send time.
 *
 * The gate reads `NotificationPreference` directly rather than Novu's copy of
 * the flags: Novu is in-app only here, and the copy it holds is a mirror
 * written after the fact, so the database row is the only truth a send can
 * rely on. A user with no row has never changed anything and gets the defaults.
 */

import prisma, { type PrismaLike } from "@/lib/prisma";
import { DEFAULT_NOTIFICATION_TIMEZONE } from "@/lib/novu/humanize";
import type { PreferenceCategory } from "@/lib/novu/templates/types";
import { resolveViewerZone } from "@/lib/time/viewer-zone";
import { canSignLinks } from "@/lib/waitlist/tokens";
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

/**
 * Defined once: the email gate and the Novu subscriber mirror
 * (`lib/novu/subscriber.ts`) both read this map.
 */
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
  notificationPreferences: PreferenceRow | null;
};

type UserReader = Pick<PrismaLike, "user">;

const PREFERENCE_SELECT = {
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
function isAllowed(
  pref: PreferenceRow | null,
  category: PreferenceCategory | null,
): boolean {
  if (category === null) return true;
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
      notificationPreferences: { select: PREFERENCE_SELECT },
    },
  });
}

/**
 * One query for every recipient of a message. Ids are deduped, input order is
 * preserved, and a user without an address is dropped because nothing can be
 * sent to them. `allowed` is decided here so callers never read the flags.
 */
export async function loadEmailRecipients(
  userIds: string[],
  category: PreferenceCategory | null,
  db: UserReader = prisma,
): Promise<EmailRecipient[]> {
  const ids = [...new Set(userIds)];
  const rows = await fetchUsers(ids, db);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const signable = category !== null && canSignLinks();

  return ids.flatMap((id) => {
    const user = byId.get(id);
    if (!user?.email) return [];
    return [
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        zone: resolveViewerZone({
          userTimezone: user.timezone,
          fallbackZone: DEFAULT_NOTIFICATION_TIMEZONE,
        }),
        allowed: isAllowed(user.notificationPreferences, category),
        unsubscribeUrl: signable ? buildEmailUnsubscribeUrl(user.id) : null,
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
  if (!user) return false;
  return isAllowed(user.notificationPreferences, category);
}
