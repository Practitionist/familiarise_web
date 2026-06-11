/**
 * Enterprise (arch-4) Novu workflow helpers.
 *
 * Layered on top of `lib/novu/service.ts` — the low-level `triggerWorkflow`
 * helpers expect explicit `subscriberId` / `userIds`. These roster
 * resolvers take an `orgId` + payload context, query `Membership` for the
 * right recipient set, and then call the low-level trigger. Keeps call
 * sites (webhook handlers, cron routes, mutation endpoints) one-liners.
 *
 * Pattern mirrors `lib/novu/service.ts` `notifyX` helpers:
 *   - Non-throwing (errors are logged; caller doesn't need try/catch).
 *   - No-op when Novu is not configured (NOVU_API_KEY absent).
 *   - Safe to call from inside a Prisma transaction — these only trigger
 *     external notification dispatch, they don't issue DB writes
 *     themselves.
 */

import type { MemberRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  NOVU_WORKFLOWS,
  type OrgInviteSentPayload,
  type OrgInviteAcceptedPayload,
  type OrgInvoiceIssuedPayload,
  type OrgInvoicePaidPayload,
  type OrgInvoiceOverduePayload,
  type OrgMemberOverageTimedOutPayload,
  type OrgLicenseRenewalUpcomingPayload,
  type OrgDataExportReadyPayload,
  type OrgWalletTopupConfirmedPayload,
  type OrgWalletLowPayload,
  type OrgPayoutCompletedPayload,
  type OrgProgramExhaustedPayload,
  type OrgProgramCapNearPayload,
  type OrgProgramOverageDuePayload,
  type OrgSsoProviderDeletedPayload,
  type OrgSsoCertExpiringPayload,
} from "./workflows";
import { getNovuClient, isNovuConfigured } from "./client";

// ============================================================================
// Internal trigger helpers (non-throwing, schema-typed)
// ============================================================================

type NovuRecord = Record<string, string | number | boolean | null | undefined>;

async function triggerOne<T extends NovuRecord>(
  workflowId: string,
  subscriberId: string,
  payload: T,
): Promise<void> {
  if (!isNovuConfigured()) return;
  try {
    const novu = getNovuClient();
    await novu.trigger({ workflowId, to: subscriberId, payload });
  } catch (err) {
    console.error(`[Novu/org] Failed to trigger ${workflowId}:`, err);
  }
}

async function triggerMany<T extends NovuRecord>(
  workflowId: string,
  subscriberIds: string[],
  payload: T,
): Promise<void> {
  if (subscriberIds.length === 0) return;
  if (!isNovuConfigured()) return;
  try {
    const novu = getNovuClient();
    await novu.trigger({ workflowId, to: subscriberIds, payload });
  } catch (err) {
    console.error(`[Novu/org] Failed to trigger ${workflowId} batch:`, err);
  }
}

// ============================================================================
// Roster resolvers — map an orgId + role-set to active-member user ids
// ============================================================================

/**
 * Returns the user ids of all ACTIVE members in an org whose role is one
 * of the requested `roles`. Excludes REMOVED / SUSPENDED memberships so
 * we don't page ex-employees.
 */
async function rosterForOrg(
  orgId: string,
  roles: MemberRole[],
): Promise<string[]> {
  if (roles.length === 0) return [];
  const members = await prisma.membership.findMany({
    where: {
      organizationId: orgId,
      status: "ACTIVE",
      role: { in: roles },
    },
    select: { userId: true },
  });
  return Array.from(new Set(members.map((m) => m.userId)));
}

/** OWNER + MAINTAINER — the "operator roster" who can act on the org. */
const OPERATOR_ROLES: MemberRole[] = ["OWNER", "MAINTAINER"];

/** OWNER + MAINTAINER + MANAGER — the "visibility roster" who can see bills + payouts. */
const VISIBILITY_ROLES: MemberRole[] = ["OWNER", "MAINTAINER", "MANAGER"];

/** OWNER only — security-critical events get a narrower blast radius. */
const OWNER_ONLY: MemberRole[] = ["OWNER"];

// ============================================================================
// Per-event helpers
// ============================================================================

/**
 * Fires when a MAINTAINER+ sends an org invite. Delivery target is the
 * invitee email (they don't have a user account yet, so we subscribe
 * Novu by email and let the dashboard config route the email channel).
 */
export async function notifyOrgInviteSent(
  inviteeEmail: string,
  payload: OrgInviteSentPayload,
): Promise<void> {
  return triggerOne(NOVU_WORKFLOWS.ORG_INVITE_SENT, inviteeEmail, payload);
}

/**
 * Fires when an invite is accepted. Delivers in-app to the org's OWNER +
 * MAINTAINER roster so they see the new joiner without having to check
 * the members list.
 */
export async function notifyOrgInviteAccepted(
  orgId: string,
  payload: OrgInviteAcceptedPayload,
): Promise<void> {
  const recipients = await rosterForOrg(orgId, OPERATOR_ROLES);
  return triggerMany(NOVU_WORKFLOWS.ORG_INVITE_ACCEPTED, recipients, payload);
}

/**
 * Fires when an invoice is issued (`status = ISSUED`). Delivers in-app to
 * OWNERs; the dashboard config emails the `billingEmail` on the org.
 */
export async function notifyOrgInvoiceIssued(
  orgId: string,
  payload: OrgInvoiceIssuedPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(NOVU_WORKFLOWS.ORG_INVOICE_ISSUED, owners, payload);
}

/**
 * Fires when an invoice transitions to PAID via webhook. Delivers in-app
 * to OWNERs.
 */
export async function notifyOrgInvoicePaid(
  orgId: string,
  payload: OrgInvoicePaidPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(NOVU_WORKFLOWS.ORG_INVOICE_PAID, owners, payload);
}

/**
 * #779 §A — dunning. Fires from the daily dunning cron both when an invoice
 * flips ISSUED→OVERDUE (reminderStage 0) and on each escalating 7-day
 * reminder (reminderStage 1..3). Delivers in-app to the finance roster
 * (OWNER + MAINTAINER + MANAGER) — the same roster that can see bills.
 */
export async function notifyOrgInvoiceOverdue(
  orgId: string,
  payload: OrgInvoiceOverduePayload,
): Promise<void> {
  const recipients = await rosterForOrg(orgId, VISIBILITY_ROLES);
  return triggerMany(NOVU_WORKFLOWS.ORG_INVOICE_OVERDUE, recipients, payload);
}

/**
 * #779 §A — a CHARGE_MEMBER overage side-charge timed out unpaid (the
 * timeout cron flipped PENDING→FAILED at 14 days). Delivers in-app to the
 * MEMBER only (mirrors notifyOrgProgramOverageDue — it's their personal
 * obligation, not an operator alert).
 */
export async function notifyMemberOverageTimedOut(
  memberUserId: string,
  payload: OrgMemberOverageTimedOutPayload,
): Promise<void> {
  return triggerMany(
    NOVU_WORKFLOWS.ORG_MEMBER_OVERAGE_TIMED_OUT,
    [memberUserId],
    payload,
  );
}

/**
 * Fires N days before a LICENSE BillingSubscription's nextInvoiceDate.
 * Owners can wire the cycle renewal into their procurement calendar
 * before the invoice lands. Drives off renewalReminderSentAt on
 * BillingSubscription so the same window only sends once per cycle.
 */
export async function notifyOrgLicenseRenewalUpcoming(
  orgId: string,
  payload: OrgLicenseRenewalUpcomingPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(
    NOVU_WORKFLOWS.ORG_LICENSE_RENEWAL_UPCOMING,
    owners,
    payload,
  );
}

/**
 * Fires when an OrgDataExportJob transitions PENDING -> READY. The
 * existing email path (process-data-exports.ts emailRequester) targets
 * only the requester; this Novu fan-out adds in-app delivery to the
 * full OWNER roster so the requester's teammates can act if the
 * requester is OOO.
 */
export async function notifyOrgDataExportReady(
  orgId: string,
  payload: OrgDataExportReadyPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(NOVU_WORKFLOWS.ORG_DATA_EXPORT_READY, owners, payload);
}

/**
 * Fires when a wallet top-up is confirmed by the payment webhook.
 * Delivers in-app to OWNERs (the initiator is usually an OWNER anyway;
 * routing to the OWNER roster ensures no delivery gap if the initiator
 * had their membership removed between top-up start and webhook).
 */
export async function notifyOrgWalletTopupConfirmed(
  orgId: string,
  payload: OrgWalletTopupConfirmedPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(
    NOVU_WORKFLOWS.ORG_WALLET_TOPUP_CONFIRMED,
    owners,
    payload,
  );
}

/**
 * #777 §C — fires from the daily wallet-low-balance cron when a WALLET
 * account dips below its configured minBalancePaise. Delivers in-app to the
 * finance roster (OWNER + MAINTAINER + MANAGER) — the same roster that can
 * see + act on the wallet (mirrors notifyOrgInvoiceOverdue).
 */
export async function notifyOrgWalletLow(
  orgId: string,
  payload: OrgWalletLowPayload,
): Promise<void> {
  const recipients = await rosterForOrg(orgId, VISIBILITY_ROLES);
  return triggerMany(NOVU_WORKFLOWS.ORG_WALLET_LOW, recipients, payload);
}

/**
 * Fires when an org payout transitions to COMPLETED by the payout cron.
 * Delivers in-app to the visibility roster (OWNER + MAINTAINER + MANAGER)
 * on canHost orgs — the same roster that can see the payout list.
 */
export async function notifyOrgPayoutCompleted(
  orgId: string,
  payload: OrgPayoutCompletedPayload,
): Promise<void> {
  const recipients = await rosterForOrg(orgId, VISIBILITY_ROLES);
  return triggerMany(NOVU_WORKFLOWS.ORG_PAYOUT_COMPLETED, recipients, payload);
}

/**
 * A1+A8: notifies the visibility roster when a payout transitions to
 * FAILED (gateway 4xx, bank rejection) or REVERSED (post-success
 * rollback). The `kind` discriminator on the payload lets the Novu
 * template render different copy per scenario without us needing two
 * separate workflow IDs.
 */
export async function notifyOrgPayoutFailed(
  orgId: string,
  payload: import("./workflows").OrgPayoutFailedPayload,
): Promise<void> {
  const recipients = await rosterForOrg(orgId, VISIBILITY_ROLES);
  const workflowId =
    payload.kind === "REVERSED"
      ? NOVU_WORKFLOWS.ORG_PAYOUT_REVERSED
      : NOVU_WORKFLOWS.ORG_PAYOUT_FAILED;
  return triggerMany(workflowId, recipients, payload);
}

/**
 * Fires when a `ProgramAssignment` hits its `coveredEngagementsPerCycle`
 * cap with `overageBehavior = BLOCK`. Delivers in-app to the assignee
 * (they need to know their booking was refused) + OWNER + MAINTAINER
 * (they need to decide whether to upsize the program).
 */
export async function notifyOrgProgramExhausted(
  orgId: string,
  assigneeUserId: string,
  payload: OrgProgramExhaustedPayload,
): Promise<void> {
  const operators = await rosterForOrg(orgId, OPERATOR_ROLES);
  const recipients = Array.from(new Set([assigneeUserId, ...operators]));
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PROGRAM_EXHAUSTED,
    recipients,
    payload,
  );
}

/**
 * #768 lockdown #22 — early-warning sibling of notifyOrgProgramExhausted.
 * Fires once per cycle when an assignment's usage CROSSES into >= 80% of
 * its cap (not on every booking past 80%). Same roster as the 100% event
 * (assignee + OWNER + MAINTAINER) so operators can upsize before bookings
 * start getting refused.
 */
export async function notifyOrgProgramCapNear(
  orgId: string,
  assigneeUserId: string,
  payload: OrgProgramCapNearPayload,
): Promise<void> {
  const operators = await rosterForOrg(orgId, OPERATOR_ROLES);
  const recipients = Array.from(new Set([assigneeUserId, ...operators]));
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PROGRAM_CAP_NEAR,
    recipients,
    payload,
  );
}

/**
 * #775 — a CHARGE_MEMBER over-cap booking created a side-charge the member
 * now owes. Delivers in-app to the MEMBER ONLY (it's their personal payment
 * obligation; operators see it on the program ledger, not as an alert).
 */
export async function notifyOrgProgramOverageDue(
  memberUserId: string,
  payload: OrgProgramOverageDuePayload,
): Promise<void> {
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PROGRAM_OVERAGE_DUE,
    [memberUserId],
    payload,
  );
}

/**
 * Security-sensitive event: an OWNER deleted an SSO provider.
 * Delivers in-app to ALL OWNERS (including the actor) so a malicious or
 * accidental deletion is visible to the rest of the owner roster.
 */
export async function notifyOrgSsoProviderDeleted(
  orgId: string,
  payload: OrgSsoProviderDeletedPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(
    NOVU_WORKFLOWS.ORG_SSO_PROVIDER_DELETED,
    owners,
    payload,
  );
}

/**
 * Fires from the daily SSO-cert-expiry cron at WARN / CRITICAL /
 * EXPIRED thresholds. Delivers in-app to OWNERs so a cert rotation
 * gets on their radar before the IdP breaks.
 */
export async function notifyOrgSsoCertExpiring(
  orgId: string,
  payload: OrgSsoCertExpiringPayload,
): Promise<void> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY);
  return triggerMany(NOVU_WORKFLOWS.ORG_SSO_CERT_EXPIRING, owners, payload);
}
