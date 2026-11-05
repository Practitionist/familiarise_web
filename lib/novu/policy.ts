import prisma, { type Tx } from "@/lib/prisma";
import { EMAIL_CATEGORY_COLUMN } from "@/lib/email/preferences";
import { computeQuietHoursNotBefore } from "./quiet-hours";
import { templateFor } from "./templates";
import { NOVU_WORKFLOWS } from "./workflows";
import type { NovuWorkflowId, PreferenceCategory } from "./templates/types";

// Security changes and actionable financial failures must reach the inbox promptly.
const URGENT_WORKFLOWS: ReadonlySet<NovuWorkflowId> = new Set([
  NOVU_WORKFLOWS.ACCOUNT_SECURITY_NOTICE,
  NOVU_WORKFLOWS.ACCOUNT_SUSPENDED,
  NOVU_WORKFLOWS.ACCOUNT_BANNED,
  NOVU_WORKFLOWS.PAYMENT_FAILED,
  NOVU_WORKFLOWS.REFUND_FAILED,
  NOVU_WORKFLOWS.PAYOUT_FAILED,
  NOVU_WORKFLOWS.ORG_PAYOUT_FAILED,
  NOVU_WORKFLOWS.DISPUTE_CREATED,
  NOVU_WORKFLOWS.COMPLIANCE_DEADLINE_ALERT,
]);

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
  erasedAt?: Date | null;
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
  if (!row || row.erasedAt) return false;
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

function computeLatestQuietHoursNotBefore(
  rows: BellUserRow[],
  allowedRecipients: string[],
): Date | undefined {
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
  return latest;
}

export async function resolveRecipientBellPolicy(
  workflowId: NovuWorkflowId,
  recipients: string[],
  opts?: {
    tx?: Pick<Tx, "user">;
    deferrable?: boolean;
  },
): Promise<{ allowedRecipients: string[]; notBefore: Date | undefined }> {
  if (recipients.length === 0) {
    return { allowedRecipients: recipients, notBefore: undefined };
  }
  const db = opts?.tx ?? prisma;
  const rows = await db.user.findMany({
    where: { id: { in: recipients } },
    select: {
      id: true,
      erasedAt: true,
      timezone: true,
      orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
      notificationPreferences: { select: BELL_PREFERENCE_SELECT },
    },
  });

  const category = templateFor(workflowId)?.category ?? null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const allowedRecipients = recipients.filter((id) =>
    isBellAllowedForRecipient(byId.get(id), category),
  );
  if (
    allowedRecipients.length === 0 ||
    opts?.deferrable === false ||
    URGENT_WORKFLOWS.has(workflowId)
  ) {
    return { allowedRecipients, notBefore: undefined };
  }
  return {
    allowedRecipients,
    notBefore: computeLatestQuietHoursNotBefore(rows, allowedRecipients),
  };
}
