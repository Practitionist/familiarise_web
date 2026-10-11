import prisma, { type Tx } from "@/lib/prisma";
import { EMAIL_CATEGORY_COLUMN } from "@/lib/email/preferences";
import { computeQuietHoursNotBefore } from "./quiet-hours";
import { templateFor } from "./templates";
import type { NovuWorkflowId, PreferenceCategory } from "./templates/types";

const BELL_PREFERENCE_SELECT = {
  allNotifications: true,
  inAppEnabled: true,
  appointmentReminders: true,
  paymentNotifications: true,
  subscriptionAlerts: true,
  trialNotifications: true,
  supportUpdates: true,
  feedbackAlerts: true,
  orgBillingAlerts: true,
  orgMembershipAlerts: true,
  orgProgramAlerts: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  quietHoursTimezone: true,
} as const;

type BellUserRow = {
  id?: string;
  timezone?: string | null;
  orgWorkspaceProfile?: {
    notificationRoutingMode?:
      "BELL_AND_EMAIL" | "BELL_ONLY" | "EMAIL_ONLY" | "NEITHER" | null;
  } | null;
  notificationPreferences?: Partial<
    Record<keyof typeof BELL_PREFERENCE_SELECT, boolean | string | null>
  > | null;
};

function isBellAllowedForRecipient(
  row: BellUserRow | undefined,
  category: PreferenceCategory | null,
): boolean {
  if (!row) return true;
  const routingMode = row.orgWorkspaceProfile?.notificationRoutingMode;
  if (routingMode === "EMAIL_ONLY" || routingMode === "NEITHER") {
    return false;
  }
  const pref = row.notificationPreferences;
  if (!pref) return true;
  if (pref.allNotifications === false) return false;
  if (pref.inAppEnabled === false) return false;
  if (category !== null && pref[EMAIL_CATEGORY_COLUMN[category]] === false) {
    return false;
  }
  return true;
}

export async function resolveRecipientBellPolicy(
  workflowId: NovuWorkflowId,
  recipients: string[],
  opts?: {
    tx?: Partial<Pick<Tx, "user">>;
    deferrable?: boolean;
  },
): Promise<{ allowedRecipients: string[]; notBefore: Date | undefined }> {
  if (recipients.length === 0) {
    return { allowedRecipients: recipients, notBefore: undefined };
  }
  try {
    const findMany = opts?.tx ? opts.tx.user?.findMany : prisma.user?.findMany;
    if (typeof findMany !== "function") {
      return { allowedRecipients: recipients, notBefore: undefined };
    }
    const rows = (await findMany({
      where: { id: { in: recipients } },
      select: {
        id: true,
        timezone: true,
        orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
        notificationPreferences: { select: BELL_PREFERENCE_SELECT },
      },
    })) as BellUserRow[];

    const category = templateFor(workflowId)?.category ?? null;
    const byId = new Map<string, BellUserRow>();
    for (const row of rows) {
      if (typeof row.id === "string") byId.set(row.id, row);
    }

    const allowedRecipients = recipients.filter((id) =>
      isBellAllowedForRecipient(byId.get(id), category),
    );
    if (allowedRecipients.length === 0 || opts?.deferrable === false) {
      return { allowedRecipients, notBefore: undefined };
    }

    const allowedSet = new Set(allowedRecipients);
    const now = new Date();
    let latest: Date | undefined;
    for (const row of rows) {
      if (typeof row.id === "string" && !allowedSet.has(row.id)) continue;
      const pref = row.notificationPreferences;
      if (!pref?.quietHoursEnabled) continue;
      const notBefore = computeQuietHoursNotBefore(
        {
          quietHoursEnabled: true,
          quietHoursStart:
            typeof pref.quietHoursStart === "string"
              ? pref.quietHoursStart
              : null,
          quietHoursEnd:
            typeof pref.quietHoursEnd === "string" ? pref.quietHoursEnd : null,
          quietHoursTimezone:
            typeof pref.quietHoursTimezone === "string"
              ? pref.quietHoursTimezone
              : null,
          fallbackTimezone: row.timezone ?? null,
        },
        now,
      );
      if (notBefore && (!latest || notBefore > latest)) latest = notBefore;
    }
    return { allowedRecipients, notBefore: latest };
  } catch {
    return { allowedRecipients: recipients, notBefore: undefined };
  }
}
