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
 *   - #691 — every trigger rides the outbox (`lib/novu/outbox.ts`): staged
 *     as a `NotificationOutbox` row, attempted inline, drained if that
 *     attempt did not settle it. Not configured → staged only.
 *   - With `{ tx }` the row and the roster read both go through the
 *     caller's transaction and nothing is sent; the helper returns the
 *     staged rows for `attemptTrigger` after the commit.
 */

import type { MemberRole } from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  NOVU_WORKFLOWS,
  type OrgDataExportReadyInput,
  type OrgDataExportReadyPayload,
  type OrgInviteAcceptedPayload,
  type OrgInviteSentInput,
  type OrgInviteSentPayload,
  type OrgInvoiceIssuedInput,
  type OrgInvoiceIssuedPayload,
  type OrgInvoiceOverdueInput,
  type OrgInvoiceOverduePayload,
  type OrgInvoicePaidInput,
  type OrgInvoicePaidPayload,
  type OrgLicenseRenewalUpcomingInput,
  type OrgLicenseRenewalUpcomingPayload,
  type OrgMemberOverageTimedOutInput,
  type OrgMemberOverageTimedOutPayload,
  type OrgPayoutCompletedInput,
  type OrgPayoutCompletedPayload,
  type OrgPayoutFailedInput,
  type OrgPayoutFailedPayload,
  type OrgProgramCapNearPayload,
  type OrgProgramExhaustedPayload,
  type OrgProgramOverageDueInput,
  type OrgProgramOverageDuePayload,
  type OrgSsoCertExpiringInput,
  type OrgSsoCertExpiringPayload,
  type OrgSsoProviderDeletedPayload,
  type OrgWalletLowInput,
  type OrgWalletLowPayload,
  type OrgWalletTopupConfirmedInput,
  type OrgWalletTopupConfirmedPayload,
} from "./workflows";
import type { NovuPayload, StagedTrigger, TriggerResult } from "./outbox";
import {
  triggerForMultiple,
  triggerForMultipleZoned,
  triggerWorkflow,
  type TriggerOptions,
} from "./service";
import type { NovuWorkflowId } from "./templates/types";
import {
  DEFAULT_NOTIFICATION_TIMEZONE,
  formatNotificationDateTime,
  formatNotificationMoney,
} from "./humanize";

// ============================================================================
// Internal trigger helpers — thin wrappers over the service cores (#691)
// ============================================================================

/**
 * #1654 — the rows a tx caller attempts after its commit. `triggerForMultiple`
 * repeats one result per recipient of a batch, so the rows are deduped by id;
 * an inline send leaves nothing behind and the list is empty.
 */
function collectStaged(results: TriggerResult[]): StagedTrigger[] {
  const byId = new Map<string, StagedTrigger>();
  for (const r of results) {
    if (r.success && r.staged) byId.set(r.staged.id, r.staged);
  }
  return Array.from(byId.values());
}

async function triggerOne(
  workflowId: NovuWorkflowId,
  subscriberId: string,
  payload: NovuPayload,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  return collectStaged([
    await triggerWorkflow(workflowId, subscriberId, payload, undefined, opts),
  ]);
}

async function triggerMany(
  workflowId: NovuWorkflowId,
  subscriberIds: string[],
  payload: NovuPayload,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  return collectStaged(
    await triggerForMultiple(
      workflowId,
      subscriberIds,
      payload,
      undefined,
      opts,
    ),
  );
}

/**
 * #536 — a roster spans people, and people span timezones, so a payload with a
 * rendered date can only be built once the recipient's zone is known. One
 * payload per distinct zone; see `triggerForMultipleZoned` for the reasoning.
 */
async function triggerManyZoned(
  workflowId: NovuWorkflowId,
  subscriberIds: string[],
  build: (timezone: string) => NovuPayload,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  return collectStaged(
    await triggerForMultipleZoned(
      workflowId,
      subscriberIds,
      build,
      undefined,
      opts,
    ),
  );
}

/** Settlement is INR-only, so an org payload without a currency is INR. */
const ORG_DEFAULT_CURRENCY = "INR";

// ============================================================================
// Roster resolvers — map an orgId + role-set to active-member user ids
// ============================================================================

/**
 * Returns the user ids of all ACTIVE members in an org whose role is one
 * of the requested `roles`. Excludes REMOVED / SUSPENDED memberships so
 * we don't page ex-employees.
 */
export async function rosterForOrg(
  orgId: string,
  roles: MemberRole[],
  // #691 — a tx caller's roster must read through its tx: PG_POOL_MAX=1
  // deadlocks a global-client read while that transaction is open.
  db: Pick<PrismaLike, "membership"> = prisma,
): Promise<string[]> {
  if (roles.length === 0) return [];
  const members = await db.membership.findMany({
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
export const OPERATOR_ROLES: MemberRole[] = ["OWNER", "MAINTAINER"];

/** OWNER + MAINTAINER + MANAGER — the "visibility roster" who can see bills + payouts. */
export const VISIBILITY_ROLES: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "MANAGER",
];

/** OWNER only — security-critical events get a narrower blast radius. */
export const OWNER_ONLY: MemberRole[] = ["OWNER"];

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
  payload: OrgInviteSentInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  // The invitee has no account yet, so there is no recorded zone to render in;
  // the platform default is used and the rendered string names it (#536).
  const wire: OrgInviteSentPayload = {
    ...payload,
    expiresAt:
      formatNotificationDateTime(
        payload.expiresAt,
        DEFAULT_NOTIFICATION_TIMEZONE,
      ) ?? payload.expiresAt,
    expiresAtIso: payload.expiresAt,
  };
  return triggerOne(NOVU_WORKFLOWS.ORG_INVITE_SENT, inviteeEmail, wire, opts);
}

/**
 * Fires when an invite is accepted. Delivers in-app to the org's OWNER +
 * MAINTAINER roster so they see the new joiner without having to check
 * the members list.
 */
export async function notifyOrgInviteAccepted(
  orgId: string,
  payload: OrgInviteAcceptedPayload,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const recipients = await rosterForOrg(
    orgId,
    OPERATOR_ROLES,
    opts?.tx ?? prisma,
  );
  return triggerMany(
    NOVU_WORKFLOWS.ORG_INVITE_ACCEPTED,
    recipients,
    payload,
    opts,
  );
}

/**
 * Fires when an invoice is issued (`status = ISSUED`). Delivers in-app to
 * OWNERs; the dashboard config emails the `billingEmail` on the org.
 */
export async function notifyOrgInvoiceIssued(
  orgId: string,
  payload: OrgInvoiceIssuedInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  return triggerManyZoned(
    NOVU_WORKFLOWS.ORG_INVOICE_ISSUED,
    owners,
    (timezone): OrgInvoiceIssuedPayload => ({
      ...payload,
      total: formatNotificationMoney(payload.totalPaise, payload.currency),
      dueDate:
        formatNotificationDateTime(payload.dueDate, timezone) ??
        payload.dueDate,
      dueDateIso: payload.dueDate,
    }),
    opts,
  );
}

/**
 * Fires when an invoice transitions to PAID via webhook. Delivers in-app
 * to OWNERs.
 */
export async function notifyOrgInvoicePaid(
  orgId: string,
  payload: OrgInvoicePaidInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  return triggerManyZoned(
    NOVU_WORKFLOWS.ORG_INVOICE_PAID,
    owners,
    (timezone): OrgInvoicePaidPayload => ({
      ...payload,
      total: formatNotificationMoney(payload.totalPaise, payload.currency),
      paidAt:
        formatNotificationDateTime(payload.paidAt, timezone) ?? payload.paidAt,
      paidAtIso: payload.paidAt,
    }),
    opts,
  );
}

/**
 * #779 §A — dunning. Fires from the daily dunning cron both when an invoice
 * flips ISSUED→OVERDUE (reminderStage 0) and on each escalating 7-day
 * reminder (reminderStage 1..3). Delivers in-app to the finance roster
 * (OWNER + MAINTAINER + MANAGER) — the same roster that can see bills.
 */
export async function notifyOrgInvoiceOverdue(
  orgId: string,
  payload: OrgInvoiceOverdueInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const recipients = await rosterForOrg(
    orgId,
    VISIBILITY_ROLES,
    opts?.tx ?? prisma,
  );
  const wire: OrgInvoiceOverduePayload = {
    ...payload,
    total: formatNotificationMoney(payload.totalPaise, payload.currency),
  };
  return triggerMany(
    NOVU_WORKFLOWS.ORG_INVOICE_OVERDUE,
    recipients,
    wire,
    opts,
  );
}

/**
 * #779 §A — a CHARGE_MEMBER overage side-charge timed out unpaid (the
 * timeout cron flipped PENDING→FAILED at 14 days). Delivers in-app to the
 * MEMBER only (mirrors notifyOrgProgramOverageDue — it's their personal
 * obligation, not an operator alert).
 */
export async function notifyMemberOverageTimedOut(
  memberUserId: string,
  payload: OrgMemberOverageTimedOutInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const wire: OrgMemberOverageTimedOutPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amountPaise, payload.currency),
  };
  return triggerMany(
    NOVU_WORKFLOWS.ORG_MEMBER_OVERAGE_TIMED_OUT,
    [memberUserId],
    wire,
    opts,
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
  payload: OrgLicenseRenewalUpcomingInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  return triggerManyZoned(
    NOVU_WORKFLOWS.ORG_LICENSE_RENEWAL_UPCOMING,
    owners,
    (timezone): OrgLicenseRenewalUpcomingPayload => ({
      ...payload,
      cycle: payload.cycle.toLowerCase(),
      cycleCode: payload.cycle,
      renewalDate:
        formatNotificationDateTime(payload.renewalDate, timezone) ??
        payload.renewalDate,
      renewalDateIso: payload.renewalDate,
      expectedTotal: formatNotificationMoney(
        payload.expectedTotalPaise,
        payload.currency,
      ),
    }),
    opts,
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
  payload: OrgDataExportReadyInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  return triggerManyZoned(
    NOVU_WORKFLOWS.ORG_DATA_EXPORT_READY,
    owners,
    (timezone): OrgDataExportReadyPayload => ({
      ...payload,
      expiresAt:
        formatNotificationDateTime(payload.expiresAt, timezone) ??
        payload.expiresAt,
      expiresAtIso: payload.expiresAt,
    }),
    opts,
  );
}

/**
 * Fires when a wallet top-up is confirmed by the payment webhook.
 * Delivers in-app to OWNERs (the initiator is usually an OWNER anyway;
 * routing to the OWNER roster ensures no delivery gap if the initiator
 * had their membership removed between top-up start and webhook).
 */
export async function notifyOrgWalletTopupConfirmed(
  orgId: string,
  payload: OrgWalletTopupConfirmedInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  const wire: OrgWalletTopupConfirmedPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amountPaise, payload.currency),
    newBalance: formatNotificationMoney(
      payload.newBalancePaise,
      payload.currency,
    ),
  };
  return triggerMany(
    NOVU_WORKFLOWS.ORG_WALLET_TOPUP_CONFIRMED,
    owners,
    wire,
    opts,
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
  payload: OrgWalletLowInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const recipients = await rosterForOrg(
    orgId,
    VISIBILITY_ROLES,
    opts?.tx ?? prisma,
  );
  const wire: OrgWalletLowPayload = {
    ...payload,
    balance: formatNotificationMoney(payload.balancePaise, payload.currency),
    minimum: formatNotificationMoney(payload.minimumPaise, payload.currency),
  };
  return triggerMany(NOVU_WORKFLOWS.ORG_WALLET_LOW, recipients, wire, opts);
}

/**
 * Fires when an org payout transitions to COMPLETED by the payout cron.
 * Delivers in-app to the visibility roster (OWNER + MAINTAINER + MANAGER)
 * on canHost orgs — the same roster that can see the payout list.
 */
export async function notifyOrgPayoutCompleted(
  orgId: string,
  payload: OrgPayoutCompletedInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const recipients = await rosterForOrg(
    orgId,
    VISIBILITY_ROLES,
    opts?.tx ?? prisma,
  );
  const wire: OrgPayoutCompletedPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amountPaise, payload.currency),
    // #1474 — `amount` is the received (post-withholding) figure; surface the
    // withheld slice alongside so the bell reconciles with Form 16A, not just
    // the bank credit.
    withheld:
      Number(payload.tdsAmountPaise ?? 0) > 0
        ? formatNotificationMoney(payload.tdsAmountPaise ?? 0, payload.currency)
        : undefined,
  };
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PAYOUT_COMPLETED,
    recipients,
    wire,
    opts,
  );
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
  payload: OrgPayoutFailedInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const recipients = await rosterForOrg(
    orgId,
    VISIBILITY_ROLES,
    opts?.tx ?? prisma,
  );
  const workflowId =
    payload.kind === "REVERSED"
      ? NOVU_WORKFLOWS.ORG_PAYOUT_REVERSED
      : NOVU_WORKFLOWS.ORG_PAYOUT_FAILED;
  const wire: OrgPayoutFailedPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amountPaise, payload.currency),
    // #1474 — same withheld split as the COMPLETED bell; FAILED carries no
    // withholding so the clause stays absent there.
    withheld:
      Number(payload.tdsAmountPaise ?? 0) > 0
        ? formatNotificationMoney(payload.tdsAmountPaise ?? 0, payload.currency)
        : undefined,
  };
  return triggerMany(workflowId, recipients, wire, opts);
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
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const operators = await rosterForOrg(
    orgId,
    OPERATOR_ROLES,
    opts?.tx ?? prisma,
  );
  const recipients = Array.from(new Set([assigneeUserId, ...operators]));
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PROGRAM_EXHAUSTED,
    recipients,
    payload,
    opts,
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
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const operators = await rosterForOrg(
    orgId,
    OPERATOR_ROLES,
    opts?.tx ?? prisma,
  );
  const recipients = Array.from(new Set([assigneeUserId, ...operators]));
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PROGRAM_CAP_NEAR,
    recipients,
    payload,
    opts,
  );
}

/**
 * #775 — a CHARGE_MEMBER over-cap booking created a side-charge the member
 * now owes. Delivers in-app to the MEMBER ONLY (it's their personal payment
 * obligation; operators see it on the program ledger, not as an alert).
 */
export async function notifyOrgProgramOverageDue(
  memberUserId: string,
  payload: OrgProgramOverageDueInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const wire: OrgProgramOverageDuePayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amountPaise, ORG_DEFAULT_CURRENCY),
  };
  return triggerMany(
    NOVU_WORKFLOWS.ORG_PROGRAM_OVERAGE_DUE,
    [memberUserId],
    wire,
    opts,
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
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  return triggerMany(
    NOVU_WORKFLOWS.ORG_SSO_PROVIDER_DELETED,
    owners,
    payload,
    opts,
  );
}

/**
 * Fires from the daily SSO-cert-expiry cron at WARN / CRITICAL /
 * EXPIRED thresholds. Delivers in-app to OWNERs so a cert rotation
 * gets on their radar before the IdP breaks.
 */
export async function notifyOrgSsoCertExpiring(
  orgId: string,
  payload: OrgSsoCertExpiringInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const owners = await rosterForOrg(orgId, OWNER_ONLY, opts?.tx ?? prisma);
  return triggerManyZoned(
    NOVU_WORKFLOWS.ORG_SSO_CERT_EXPIRING,
    owners,
    (timezone): OrgSsoCertExpiringPayload => ({
      ...payload,
      notAfter:
        formatNotificationDateTime(payload.notAfter, timezone) ??
        payload.notAfter,
      notAfterIso: payload.notAfter,
    }),
    opts,
  );
}
