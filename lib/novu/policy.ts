import prisma, { type Tx } from "@/lib/prisma";
import { EMAIL_CATEGORY_COLUMN } from "@/lib/email/preferences";
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
} as const;

const BELL_POLICY_SELECT = {
  id: true,
  erasedAt: true,
  orgWorkspaceProfile: { select: { notificationRoutingMode: true } },
  notificationPreferences: { select: BELL_PREFERENCE_SELECT },
} as const;

type BellUserRow = {
  id?: string;
  erasedAt?: Date | null;
  orgWorkspaceProfile?: {
    notificationRoutingMode?:
      "BELL_AND_EMAIL" | "BELL_ONLY" | "EMAIL_ONLY" | "NEITHER" | null;
  } | null;
  notificationPreferences?: Partial<
    Record<keyof typeof BELL_PREFERENCE_SELECT, boolean | null>
  > | null;
};

function isBellAllowedForRecipient(
  row: BellUserRow | undefined,
  category: PreferenceCategory | null,
): boolean {
  if (!row) return true;
  if (row.erasedAt) return false;
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

function allowedRecipientsOf(
  workflowId: NovuWorkflowId,
  recipients: string[],
  rows: BellUserRow[],
): string[] {
  const category = templateFor(workflowId)?.category ?? null;
  const byId = new Map(
    rows
      .filter(
        (r): r is BellUserRow & { id: string } => typeof r.id === "string",
      )
      .map((r) => [r.id, r]),
  );
  return recipients.filter((id) =>
    isBellAllowedForRecipient(byId.get(id), category),
  );
}

/** Staging-time filter; the first attempt rechecks once with {@link currentBellRecipients}. */
export async function resolveRecipientBellPolicy(
  workflowId: NovuWorkflowId,
  recipients: string[],
  opts?: { tx?: Partial<Pick<Tx, "user">> },
): Promise<{ allowedRecipients: string[] }> {
  if (recipients.length === 0) return { allowedRecipients: recipients };
  try {
    const findMany = opts?.tx ? opts.tx.user?.findMany : prisma.user?.findMany;
    if (typeof findMany !== "function") {
      return { allowedRecipients: recipients };
    }
    const rows = (await findMany({
      where: { id: { in: recipients } },
      select: BELL_POLICY_SELECT,
    })) as BellUserRow[];
    return {
      allowedRecipients: allowedRecipientsOf(workflowId, recipients, rows),
    };
  } catch (err) {
    if (opts?.tx) throw err;
    return { allowedRecipients: recipients };
  }
}

/**
 * Every user a bell may reach now, in id order: verified, not banned, and
 * allowed by {@link allowedRecipientsOf}. Refuses (`null`) rather than
 * truncating when more than `cap` users would have to be read.
 */
export async function bellAudience(
  tx: Pick<Tx, "user">,
  workflowId: NovuWorkflowId,
  cap: number,
): Promise<string[] | null> {
  const rows = await tx.user.findMany({
    where: { emailVerified: true, banned: false, erasedAt: null },
    select: BELL_POLICY_SELECT,
    orderBy: { id: "asc" },
    take: cap + 1,
  });
  if (rows.length > cap) return null;
  return allowedRecipientsOf(
    workflowId,
    rows.map((row) => row.id),
    rows,
  );
}

/**
 * The recipients a bell may reach right now. Throws on a failed read so the
 * caller retries later instead of sending unchecked.
 */
export async function currentBellRecipients(
  workflowId: NovuWorkflowId,
  recipients: string[],
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: recipients } },
    select: BELL_POLICY_SELECT,
  });
  // A recipient whose user row is gone has no subscriber left to ring.
  const known = new Set(rows.map((row) => row.id));
  return allowedRecipientsOf(
    workflowId,
    recipients.filter((id) => known.has(id)),
    rows,
  );
}
