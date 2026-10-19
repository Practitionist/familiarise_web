/** Shared case intake and notifications for platform and appointment help. */

import prisma, { type PrismaLike } from "@/lib/prisma";
import type {
  SupportIssueType,
  SupportPriority,
  SupportCase,
} from "@prisma/client";
import {
  notifySupportTicketActivity,
  notifySupportTicketCreated,
  notifySupportTicketResponse,
} from "@/lib/novu";
import { sendSupportTicketReceivedEmail } from "@/lib/email/senders/people";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { reportSentryError } from "@/lib/observability/report";
import { stripCallbackTags } from "@/lib/validation/phone";
import { createOrReuseSupportCase } from "./case-service";
import { caseKeyOf } from "./case-key";

/**
 * Issue types that describe WHAT HAPPENED IN A SESSION. The platform-level
 * ticket form and the platform intake must not offer them — a user with one of
 * these picks the session first, and the per-appointment flowchart thread
 * routes it (with context) into the queue.
 */
export const SESSION_SCOPED_ISSUE_TYPES: ReadonlySet<SupportIssueType> =
  new Set([
    "CONSULTANT_NO_SHOW",
    "CONSULTANT_LATE",
    "SESSION_ENDED_EARLY",
    "SESSION_QUALITY_POOR",
    "COMMUNICATION_ISSUE",
    "WRONG_CONSULTANT",
    "ACCESS_ISSUE",
    "TIMEZONE_CONFUSION",
    "RESCHEDULING_HELP",
    "WANT_TO_CANCEL",
    "CANCELLATION_ISSUE",
    "DOCUMENT_ISSUE",
  ]);

export interface CreateSupportTicketInput {
  userId: string;
  title: string;
  description: string;
  /** Already Zod-validated; the only source of the callback marker. */
  callbackPhone?: string | null;
  priority?: SupportPriority;
  category?: string | null;
  issueType?: SupportIssueType | null;
  paymentId?: string | null;
  /** The booking this case is about. The canonical anchor for a session case. */
  appointmentId?: string | null;
  /** Org attribution (operator intake / escalated org threads). Null = B2C. */
  organizationId?: string | null;
  /** Only a ticket the requester filed themselves earns them a "request received" receipt. */
  filedBy: "requester" | "system";
}

/**
 * Ops recipients, each with the case URL THEY can open: `/dashboard/admin/*`
 * is ADMIN-only (STAFF are sent to the staff twin), while the staff tree
 * admits both roles. One trigger per recipient, since the href differs.
 */
async function opsRecipients(
  ticketId: string,
  assigneeId?: string | null,
  caseKind: "ticket" | "case" = "case",
): Promise<Array<{ id: string; dashboardUrl: string }>> {
  const users = await prisma.user.findMany({
    where: assigneeId
      ? { id: assigneeId }
      : { role: { in: ["STAFF", "ADMIN"] } },
    select: { id: true, role: true },
  });
  // #1527 — the case in the Support inbox, in the recipient's own tree.
  const caseKey = caseKeyOf({ kind: caseKind, id: ticketId });
  return users.map((u) => ({
    id: u.id,
    dashboardUrl: `/dashboard/${u.role === "ADMIN" ? "admin" : "staff"}/support/${caseKey}`,
  }));
}

/**
 * Fire-and-forget staff notification — shared by every creation path.
 *
 * Exported because the per-appointment escalation creates its ticket INSIDE a
 * transaction (atomically with the thread's state change) and so cannot use
 * `createSupportTicket`. It calls this after the transaction commits, which
 * keeps the invariant that matters: staff are never told about a ticket a
 * rollback then erased.
 */
export async function notifySupportStaff(
  ticket: Pick<
    SupportCase,
    "id" | "title" | "organizationId" | "referenceNumber"
  > & { userId: string },
  caseKind: "ticket" | "case" = "case",
): Promise<void> {
  // ADR 23 — the notification inherits the ticket's org-ness (attribution +
  // deep-link filing only; recipient lists are unchanged).
  let orgName: string | null = null;
  if (ticket.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: ticket.organizationId },
      select: { name: true },
    });
    orgName = org?.name ?? null;
  }
  const [ops, customer] = await Promise.all([
    opsRecipients(ticket.id, undefined, caseKind),
    prisma.user.findUnique({
      where: { id: ticket.userId },
      select: { name: true },
    }),
  ]);
  const results = await Promise.all(
    ops.map((recipient) =>
      notifySupportTicketCreated(
        [recipient.id],
        {
          ticketId: ticket.id,
          reference: ticket.referenceNumber ?? undefined,
          ticketTitle: ticket.title || "Support Ticket",
          userName: customer?.name ?? undefined,
          dashboardUrl: recipient.dashboardUrl,
          ...notificationScope(ticket.organizationId, orgName),
        },
        undefined,
        { deferAttempt: true },
      ),
    ),
  );
  await flushNotificationsAfter(
    { bells: results.flat().map((r) => r.staged) },
    "support.ticket-created",
  );
}

/**
 * #705 — page ops when the USER adds to an existing ticket. Both directions of
 * this conversation now notify: previously a reply into an escalated thread, or
 * onto a ticket, told nobody, so staff only learned of it by reopening the
 * inbox. Prefers the assignee — fanning every reply at every staff member is
 * how a queue's notifications get muted.
 */
export async function notifyStaffOfTicketActivity(
  ticketId: string,
  organizationId?: string | null,
  /**
   * Identifies THIS activity. Without it `deriveTransactionId` falls back to
   * hashing the payload, which is byte-identical for every reply on the same
   * ticket — staging upserts on transactionId, so only the first reply
   * would ever have paged anyone.
   */
  eventId?: string,
  activity: "replied" | "reopened" = "replied",
): Promise<void> {
  const ticket = await prisma.supportCase.findUnique({
    where: { id: ticketId },
    select: {
      requesterUserId: true,
      title: true,
      assignedToId: true,
      referenceNumber: true,
      organizationId: true,
      requester: { select: { name: true } },
    },
  });
  if (!ticket) return;
  const effectiveOrgId = organizationId ?? ticket.organizationId;
  const recipients = await opsRecipients(ticketId, ticket.assignedToId, "case");
  if (recipients.length === 0) return;
  const dedupeKey = eventId ?? `${ticketId}:${Date.now()}`;
  const results = await Promise.all(
    recipients.map((recipient) =>
      notifySupportTicketActivity(
        [recipient.id],
        {
          ticketId,
          reference: ticket.referenceNumber ?? undefined,
          ticketTitle: ticket.title,
          userName: ticket.requester.name ?? undefined,
          activity,
          dashboardUrl: recipient.dashboardUrl,
          ...notificationScope(effectiveOrgId),
        },
        dedupeKey,
        { deferAttempt: true },
      ),
    ),
  );
  await flushNotificationsAfter(
    { bells: results.flat().map((r) => r.staged) },
    "support.ticket-activity",
  );
}

/** The acknowledgement window the ticket was actually given, in whole hours. */
function slaWindowOf(createdAt: Date, ackDueAt: Date | null): string | null {
  if (!ackDueAt) return null;
  const hours = Math.ceil(
    (ackDueAt.getTime() - createdAt.getTime()) / 3_600_000,
  );
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** Send statutory intake receipt (in-app bell + email) without setting acknowledgedAt. */
export async function notifyRequesterOfTicket(
  ticket: Pick<
    SupportCase,
    | "id"
    | "title"
    | "referenceNumber"
    | "ackDueAt"
    | "createdAt"
    | "organizationId"
  > & { userId: string },
  caseKind: "ticket" | "case" = "case",
): Promise<void> {
  const reference = ticket.referenceNumber ?? ticket.id;
  const title = ticket.title || "Support Ticket";
  const slaWindow = slaWindowOf(ticket.createdAt, ticket.ackDueAt);
  const ticketUrl = supportRequestHref(
    caseKeyOf({ kind: caseKind, id: ticket.id }),
    ticket.organizationId,
  );

  const novuOutbox: StagedTrigger | null = await stageBell(prisma, {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_RECEIVED,
    recipients: [ticket.userId],
    payload: {
      ticketId: ticket.id,
      reference,
      ticketTitle: title,
      ...(slaWindow ? { slaWindow } : {}),
      dashboardUrl: ticketUrl,
      ...notificationScope(ticket.organizationId),
    },
    dedupeKey: `ticket-received:${ticket.id}`,
  }).catch((error) => {
    reportSentryError(error, {
      subsystem: "support",
      op: "ticket-receipt",
      extra: { ticketId: ticket.id },
    });
    return null;
  });

  await Promise.all([
    flushNotificationsAfter({ bells: [novuOutbox] }, "support.ticket-receipt"),
    sendSupportTicketReceivedEmail(
      {
        ticketId: ticket.id,
        ownerUserId: ticket.userId,
        reference,
        title,
        slaWindow,
        ticketUrl,
      },
      3_000,
    ),
  ]);
}

/**
 * Create a support ticket + notify the ops queue. Callers own validation and
 * dedup (e.g. the paymentId dedup is a route-level UX decision).
 */
export async function createSupportTicket(
  input: CreateSupportTicketInput,
): Promise<SupportCase> {
  const result = await createOrReuseSupportCase({
    requesterUserId: input.userId,
    submitterUserId: input.userId,
    title: input.title,
    description: stripCallbackTags(input.description).trim(),
    callbackPhone: input.callbackPhone,
    priority: input.priority,
    category: input.category ?? input.issueType ?? "GENERAL_INQUIRY",
    issueType: input.issueType,
    organizationId: input.organizationId,
    appointmentId: input.appointmentId,
    activeChannel: "HUMAN",
    subjects: input.paymentId
      ? [
          {
            subjectType: "PAYMENT",
            subjectId: input.paymentId,
            isPrimary: true,
          },
        ]
      : undefined,
  });
  const supportCase = result.supportCase;
  if (!result.reused) {
    const receipt = { ...supportCase, userId: supportCase.requesterUserId };
    await Promise.all([
      notifySupportStaff(receipt, "case").catch(console.error),
      input.filedBy === "requester"
        ? notifyRequesterOfTicket(receipt, "case").catch(console.error)
        : Promise.resolve(),
    ]);
  }
  return supportCase;
}

export async function findRecentOpenEscalation(
  userId: string,
  issueType: SupportIssueType,
  organizationId: string | null,
): Promise<SupportCase | null> {
  return prisma.supportCase.findFirst({
    where: {
      requesterUserId: userId,
      submitterUserId: userId,
      issueType,
      organizationId,
      status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "ON_HOLD"] },
      deletedAt: null,
      createdAt: { gte: new Date(Date.now() - 30 * 60_000) },
    },
    orderBy: { createdAt: "desc" },
  });
}

export function raiseReusedTicketToHigh(db: PrismaLike, ticketId: string) {
  return db.supportCase.updateMany({
    where: {
      id: ticketId,
      closedAt: null,
      deletedAt: null,
      priority: { in: ["LOW", "MEDIUM"] },
    },
    data: { priority: "HIGH" },
  });
}

export interface CreateOutboundStaffSupportTicketInput {
  staffUserId: string;
  staffUserName: string | null | undefined;
  targetLookup: string;
  title: string;
  description: string;
  priority?: SupportPriority;
  category?: string | null;
  issueType?: SupportIssueType | null;
  organizationId?: string | null;
  paymentId?: string | null;
}

export async function createOutboundStaffSupportTicket(
  input: CreateOutboundStaffSupportTicketInput,
): Promise<SupportCase | null> {
  const targetUser = input.targetLookup.includes("@")
    ? await prisma.user.findFirst({
        where: { email: { equals: input.targetLookup, mode: "insensitive" } },
        select: { id: true },
      })
    : await prisma.user.findUnique({
        where: { id: input.targetLookup },
        select: { id: true },
      });
  if (!targetUser) return null;
  const [membership, payment] = await Promise.all([
    input.organizationId
      ? prisma.membership.findFirst({
          where: {
            organizationId: input.organizationId,
            userId: targetUser.id,
            status: "ACTIVE",
          },
          select: { organizationId: true },
        })
      : null,
    input.paymentId
      ? prisma.payment.findFirst({
          where: { id: input.paymentId, userId: targetUser.id },
          select: { id: true },
        })
      : null,
  ]);
  if ((input.organizationId && !membership) || (input.paymentId && !payment))
    throw new Error("Support subject does not belong to the requester");
  const result = await createOrReuseSupportCase({
    requesterUserId: targetUser.id,
    submitterUserId: input.staffUserId,
    title: input.title,
    description: stripCallbackTags(input.description).trim(),
    priority: input.priority,
    category: input.category ?? input.issueType ?? "GENERAL_INQUIRY",
    issueType: input.issueType,
    organizationId: membership?.organizationId ?? null,
    activeChannel: "HUMAN",
    subjects: payment
      ? [{ subjectType: "PAYMENT", subjectId: payment.id, isPrimary: true }]
      : undefined,
  });
  const supportCase = result.supportCase;
  const bell = await notifySupportTicketResponse(
    targetUser.id,
    {
      ticketId: supportCase.id,
      reference: supportCase.referenceNumber,
      ticketTitle: supportCase.title,
      message: supportCase.description,
      respondedBy: input.staffUserName ?? "Support",
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "case", id: supportCase.id }),
        supportCase.organizationId,
      ),
      ...notificationScope(supportCase.organizationId),
    },
    `case-outbound:${supportCase.id}`,
    { deferAttempt: true },
  ).catch((error) => {
    reportSentryError(error, {
      subsystem: "support",
      op: "outbound.notifyUser",
      extra: { caseId: supportCase.id },
    });
    return null;
  });
  await flushNotificationsAfter(
    { bells: [bell?.staged] },
    "support.outbound-case",
  );
  return supportCase;
}
