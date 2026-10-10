/**
 * Enterprise Novu workflow helpers.
 *
 * Layered on top of `lib/novu/service.ts` — takes an `orgId` + payload context,
 * resolves active `Membership` recipients for the target role set, and stages
 * via the outbox (`lib/novu/outbox.ts`).
 */

import type { MemberRole } from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  NOVU_WORKFLOWS,
  notificationScope,
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

const DATE_FALLBACK = "the date shown in your dashboard";
const ORG_DEFAULT_CURRENCY = "INR";
const W = NOVU_WORKFLOWS;

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

// ============================================================================
// Roster resolvers
// ============================================================================

export async function rosterForOrg(
  orgId: string,
  roles: MemberRole[],
  db: Pick<PrismaLike, "membership"> = prisma,
): Promise<string[]> {
  if (roles.length === 0) return [];
  const members = await db.membership.findMany({
    where: { organizationId: orgId, status: "ACTIVE", role: { in: roles } },
    select: { userId: true },
  });
  return Array.from(new Set(members.map((m) => m.userId)));
}

export const OPERATOR_ROLES: MemberRole[] = ["OWNER", "MAINTAINER"];
export const VISIBILITY_ROLES: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "MANAGER",
];
export const OWNER_ONLY: MemberRole[] = ["OWNER"];

// ============================================================================
// Declarative org notifier builders
// ============================================================================

function withheldMoney(tdsAmountPaise: number | undefined, currency: string) {
  return Number(tdsAmountPaise ?? 0) > 0
    ? formatNotificationMoney(tdsAmountPaise ?? 0, currency)
    : undefined;
}

function zonedDate(raw: string, timezone: string): string {
  return formatNotificationDateTime(raw, timezone) ?? DATE_FALLBACK;
}

function defineOrgRosterNotifier<TInput extends { orgName: string }>(
  workflowId: NovuWorkflowId | ((payload: TInput) => NovuWorkflowId),
  roles: MemberRole[],
  mapPayload: (payload: TInput) => Record<string, unknown> = () => ({}),
) {
  return async (
    orgId: string,
    payload: TInput,
    opts?: TriggerOptions,
  ): Promise<StagedTrigger[]> => {
    const recipients = await rosterForOrg(orgId, roles, opts?.tx ?? prisma);
    const id =
      typeof workflowId === "function" ? workflowId(payload) : workflowId;
    return triggerMany(
      id,
      recipients,
      {
        ...notificationScope(orgId, payload.orgName),
        ...payload,
        ...mapPayload(payload),
      } as NovuPayload,
      opts,
    );
  };
}

function defineOrgZonedRosterNotifier<TInput extends { orgName: string }>(
  workflowId: NovuWorkflowId,
  roles: MemberRole[],
  mapPayload: (payload: TInput, timezone: string) => Record<string, unknown>,
) {
  return async (
    orgId: string,
    payload: TInput,
    opts?: TriggerOptions,
  ): Promise<StagedTrigger[]> => {
    const recipients = await rosterForOrg(orgId, roles, opts?.tx ?? prisma);
    return triggerManyZoned(
      workflowId,
      recipients,
      (tz) =>
        ({
          ...notificationScope(orgId, payload.orgName),
          ...payload,
          ...mapPayload(payload, tz),
        }) as NovuPayload,
      opts,
    );
  };
}

function defineOrgAssigneeRosterNotifier<TInput extends { orgName: string }>(
  workflowId: NovuWorkflowId,
  roles: MemberRole[],
) {
  return async (
    orgId: string,
    assigneeUserId: string,
    payload: TInput,
    opts?: TriggerOptions,
  ): Promise<StagedTrigger[]> => {
    const operators = await rosterForOrg(orgId, roles, opts?.tx ?? prisma);
    const recipients = Array.from(new Set([assigneeUserId, ...operators]));
    return triggerMany(
      workflowId,
      recipients,
      {
        ...notificationScope(orgId, payload.orgName),
        ...payload,
      } as NovuPayload,
      opts,
    );
  };
}

function defineOrgMemberNotifier<
  TInput extends { organizationId?: string | null },
>(
  workflowId: NovuWorkflowId,
  mapPayload: (payload: TInput) => Record<string, unknown>,
) {
  return (
    memberUserId: string,
    payload: TInput,
    opts?: TriggerOptions,
  ): Promise<StagedTrigger[]> =>
    triggerMany(
      workflowId,
      [memberUserId],
      {
        organizationId: payload.organizationId ?? null,
        scope: "org",
        ...payload,
        ...mapPayload(payload),
      } as NovuPayload,
      opts,
    );
}

// ============================================================================
// Per-event helpers
// ============================================================================

export async function notifyOrgInviteSent(
  inviteeEmail: string,
  payload: OrgInviteSentInput,
  opts?: TriggerOptions,
): Promise<StagedTrigger[]> {
  const wire: OrgInviteSentPayload = {
    organizationId: payload.organizationId ?? null,
    scope: "org",
    ...payload,
    expiresAt: zonedDate(payload.expiresAt, DEFAULT_NOTIFICATION_TIMEZONE),
    expiresAtIso: payload.expiresAt,
  };
  return triggerOne(W.ORG_INVITE_SENT, inviteeEmail, wire, opts);
}

export const notifyOrgInviteAccepted =
  defineOrgRosterNotifier<OrgInviteAcceptedPayload>(
    W.ORG_INVITE_ACCEPTED,
    OPERATOR_ROLES,
  );

export const notifyOrgInvoiceIssued =
  defineOrgZonedRosterNotifier<OrgInvoiceIssuedInput>(
    W.ORG_INVOICE_ISSUED,
    OWNER_ONLY,
    (p, tz): Partial<OrgInvoiceIssuedPayload> => ({
      total: formatNotificationMoney(p.totalPaise, p.currency),
      dueDate: zonedDate(p.dueDate, tz),
      dueDateIso: p.dueDate,
    }),
  );

export const notifyOrgInvoicePaid =
  defineOrgZonedRosterNotifier<OrgInvoicePaidInput>(
    W.ORG_INVOICE_PAID,
    OWNER_ONLY,
    (p, tz): Partial<OrgInvoicePaidPayload> => ({
      total: formatNotificationMoney(p.totalPaise, p.currency),
      paidAt: zonedDate(p.paidAt, tz),
      paidAtIso: p.paidAt,
    }),
  );

export const notifyOrgInvoiceOverdue =
  defineOrgRosterNotifier<OrgInvoiceOverdueInput>(
    W.ORG_INVOICE_OVERDUE,
    VISIBILITY_ROLES,
    (p): Partial<OrgInvoiceOverduePayload> => ({
      total: formatNotificationMoney(p.totalPaise, p.currency),
    }),
  );

export const notifyMemberOverageTimedOut =
  defineOrgMemberNotifier<OrgMemberOverageTimedOutInput>(
    W.ORG_MEMBER_OVERAGE_TIMED_OUT,
    (p): Partial<OrgMemberOverageTimedOutPayload> => ({
      amount: formatNotificationMoney(p.amountPaise, p.currency),
    }),
  );

export const notifyOrgLicenseRenewalUpcoming =
  defineOrgZonedRosterNotifier<OrgLicenseRenewalUpcomingInput>(
    W.ORG_LICENSE_RENEWAL_UPCOMING,
    OWNER_ONLY,
    (p, tz): Partial<OrgLicenseRenewalUpcomingPayload> => ({
      cycle: p.cycle.toLowerCase(),
      cycleCode: p.cycle,
      renewalDate: zonedDate(p.renewalDate, tz),
      renewalDateIso: p.renewalDate,
      expectedTotal: formatNotificationMoney(p.expectedTotalPaise, p.currency),
    }),
  );

export const notifyOrgDataExportReady =
  defineOrgZonedRosterNotifier<OrgDataExportReadyInput>(
    W.ORG_DATA_EXPORT_READY,
    OWNER_ONLY,
    (p, tz): Partial<OrgDataExportReadyPayload> => ({
      expiresAt: zonedDate(p.expiresAt, tz),
      expiresAtIso: p.expiresAt,
    }),
  );

export const notifyOrgWalletTopupConfirmed =
  defineOrgRosterNotifier<OrgWalletTopupConfirmedInput>(
    W.ORG_WALLET_TOPUP_CONFIRMED,
    OWNER_ONLY,
    (p): Partial<OrgWalletTopupConfirmedPayload> => ({
      amount: formatNotificationMoney(p.amountPaise, p.currency),
      newBalance: formatNotificationMoney(p.newBalancePaise, p.currency),
    }),
  );

export const notifyOrgWalletLow = defineOrgRosterNotifier<OrgWalletLowInput>(
  W.ORG_WALLET_LOW,
  VISIBILITY_ROLES,
  (p): Partial<OrgWalletLowPayload> => ({
    balance: formatNotificationMoney(p.balancePaise, p.currency),
    minimum: formatNotificationMoney(p.minimumPaise, p.currency),
  }),
);

export const notifyOrgPayoutCompleted =
  defineOrgRosterNotifier<OrgPayoutCompletedInput>(
    W.ORG_PAYOUT_COMPLETED,
    VISIBILITY_ROLES,
    (p): Partial<OrgPayoutCompletedPayload> => ({
      amount: formatNotificationMoney(p.amountPaise, p.currency),
      withheld: withheldMoney(p.tdsAmountPaise, p.currency),
    }),
  );

export const notifyOrgPayoutFailed =
  defineOrgRosterNotifier<OrgPayoutFailedInput>(
    (p) =>
      p.kind === "REVERSED" ? W.ORG_PAYOUT_REVERSED : W.ORG_PAYOUT_FAILED,
    VISIBILITY_ROLES,
    (p): Partial<OrgPayoutFailedPayload> => ({
      reason: p.reason?.trim() ? p.reason : "no reason was given",
      amount: formatNotificationMoney(p.amountPaise, p.currency),
      withheld: withheldMoney(p.tdsAmountPaise, p.currency),
    }),
  );

export const notifyOrgProgramExhausted =
  defineOrgAssigneeRosterNotifier<OrgProgramExhaustedPayload>(
    W.ORG_PROGRAM_EXHAUSTED,
    OPERATOR_ROLES,
  );

export const notifyOrgProgramCapNear =
  defineOrgAssigneeRosterNotifier<OrgProgramCapNearPayload>(
    W.ORG_PROGRAM_CAP_NEAR,
    OPERATOR_ROLES,
  );

export const notifyOrgProgramOverageDue =
  defineOrgMemberNotifier<OrgProgramOverageDueInput>(
    W.ORG_PROGRAM_OVERAGE_DUE,
    (p): Partial<OrgProgramOverageDuePayload> => ({
      amount: formatNotificationMoney(p.amountPaise, ORG_DEFAULT_CURRENCY),
    }),
  );

export const notifyOrgSsoProviderDeleted =
  defineOrgRosterNotifier<OrgSsoProviderDeletedPayload>(
    W.ORG_SSO_PROVIDER_DELETED,
    OWNER_ONLY,
  );
