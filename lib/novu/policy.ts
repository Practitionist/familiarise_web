import type { Prisma } from "@prisma/client";
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
  notificationPreferences: { select: BELL_PREFERENCE_SELECT },
} as const;

type BellUserRow = {
  id?: string;
  erasedAt?: Date | null;
  notificationPreferences?: Partial<
    Record<keyof typeof BELL_PREFERENCE_SELECT, boolean | null>
  > | null;
};

/** How a workflow is gated: its preference switch, or none when it is required. */
type BellGate = { category: PreferenceCategory | null; required: boolean };

/** `requiredSend`: this send is a required notice (`lib/notifications/required-notices.ts`). */
function gateOf(workflowId: NovuWorkflowId, requiredSend = false): BellGate {
  const template = templateFor(workflowId);
  return {
    category: template?.category ?? null,
    required: requiredSend || template?.required === true,
  };
}

function isBellAllowedForRecipient(
  row: BellUserRow | undefined,
  { category, required }: BellGate,
): boolean {
  if (!row) return true;
  if (row.erasedAt) return false;
  if (required) return true;
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
  gate: BellGate,
  recipients: string[],
  rows: BellUserRow[],
): string[] {
  const byId = new Map(
    rows
      .filter(
        (r): r is BellUserRow & { id: string } => typeof r.id === "string",
      )
      .map((r) => [r.id, r]),
  );
  return recipients.filter((id) =>
    isBellAllowedForRecipient(byId.get(id), gate),
  );
}

/** Staging-time filter; the first attempt rechecks once with {@link currentBellRecipients}. */
export async function resolveRecipientBellPolicy(
  workflowId: NovuWorkflowId,
  recipients: string[],
  opts?: { tx?: Partial<Pick<Tx, "user">>; required?: boolean },
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
      allowedRecipients: allowedRecipientsOf(
        gateOf(workflowId, opts?.required),
        recipients,
        rows,
      ),
    };
  } catch (err) {
    if (opts?.tx) throw err;
    return { allowedRecipients: recipients };
  }
}

/**
 * Largest audience one fan-out stages. Every recipient is one Novu workflow
 * run, so this keeps a single post well inside the monthly run quota.
 */
export const MAX_BELL_AUDIENCE = 2_000;

/**
 * {@link isBellAllowedForRecipient} as a query filter, so a cap counts only
 * the users a bell may reach.
 */
function bellAllowedWhere({
  category,
  required,
}: BellGate): Prisma.UserWhereInput {
  if (required) return { erasedAt: null };
  const preference: Prisma.NotificationPreferenceWhereInput = {
    allNotifications: true,
    inAppEnabled: true,
  };
  if (category !== null) preference[EMAIL_CATEGORY_COLUMN[category]] = true;
  return {
    erasedAt: null,
    OR: [
      { notificationPreferences: { is: null } },
      { notificationPreferences: { is: preference } },
    ],
  };
}

/**
 * Every user a bell may reach now, in id order: verified, not banned, and
 * allowed by {@link allowedRecipientsOf}. Refuses (`null`) rather than
 * truncating when more than `cap` such users exist.
 */
export async function bellAudience(
  tx: Pick<Tx, "user">,
  workflowId: NovuWorkflowId,
  cap: number,
  opts?: { required?: boolean },
): Promise<string[] | null> {
  const gate = gateOf(workflowId, opts?.required);
  const rows = await tx.user.findMany({
    where: {
      emailVerified: true,
      banned: false,
      ...bellAllowedWhere(gate),
    },
    select: BELL_POLICY_SELECT,
    orderBy: { id: "asc" },
    take: cap + 1,
  });
  if (rows.length > cap) return null;
  return allowedRecipientsOf(
    gate,
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
  opts?: { required?: boolean },
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: recipients } },
    select: BELL_POLICY_SELECT,
  });
  // A recipient whose user row is gone has no subscriber left to ring.
  const known = new Set(rows.map((row) => row.id));
  return allowedRecipientsOf(
    gateOf(workflowId, opts?.required),
    recipients.filter((id) => known.has(id)),
    rows,
  );
}

/**
 * The recipients whose user row still exists and is not erased. Throws on a
 * failed read so the caller retries later instead of sending unchecked.
 */
export async function unerasedRecipients(
  recipients: string[],
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: recipients } },
    select: { id: true, erasedAt: true },
  });
  const live = new Set(
    rows.filter((row) => !row.erasedAt).map((row) => row.id),
  );
  return recipients.filter((id) => live.has(id));
}
