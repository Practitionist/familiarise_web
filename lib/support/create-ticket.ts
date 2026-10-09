/**
 * #support-hub — the single factory for creating SupportTickets, shared by the
 * legacy user route, the per-appointment escalation path, and the platform
 * intake. One place for: staff notification, org attribution, and the
 * session-scope guard that keeps appointment-specific issue types out of the
 * platform queue (they belong on the per-appointment "Get help" threads).
 */

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import type {
  SupportIssueType,
  SupportPriority,
  SupportTicket,
} from "@prisma/client";
import {
  notifySupportTicketActivity,
  notifySupportTicketCreated,
  notifySupportTicketResponse,
} from "@/lib/novu";
import { sendSupportTicketReceivedEmail } from "@/lib/email/senders/people";
import { attemptTrigger, stageTrigger } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { reportSentryError } from "@/lib/observability/report";
import { stripCallbackTags } from "@/lib/validation/phone";
import { withSupportAttachmentHrefs } from "./attachment-href";
import { caseKeyOf } from "./case-key";
import { allocateTicketReference } from "./reference";
import { slaDeadlinesFor } from "./sla";

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

export function isSessionScopedIssueType(
  issueType: SupportIssueType | null | undefined,
): boolean {
  return !!issueType && SESSION_SCOPED_ISSUE_TYPES.has(issueType);
}

export interface CreateSupportTicketInput {
  userId: string;
  title: string;
  description: string;
  /** Already Zod-validated; the only source of the callback marker. */
  callbackPhone?: string | null;
  priority?: SupportPriority;
  category?: string | null;
  issueType?: SupportIssueType | null;
  consultationId?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
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
): Promise<Array<{ id: string; dashboardUrl: string }>> {
  const users = await prisma.user.findMany({
    where: assigneeId
      ? { id: assigneeId }
      : { role: { in: ["STAFF", "ADMIN"] } },
    select: { id: true, role: true },
  });
  // #1527 — the case in the Support inbox, in the recipient's own tree.
  const caseKey = caseKeyOf({ kind: "ticket", id: ticketId });
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
    SupportTicket,
    "id" | "title" | "organizationId" | "referenceNumber" | "userId"
  >,
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
  const [recipients, customer] = await Promise.all([
    opsRecipients(ticket.id),
    prisma.user.findUnique({
      where: { id: ticket.userId },
      select: { name: true },
    }),
  ]);
  // Awaited, not void: a Netlify instance freezes once the response is sent,
  // and a trigger still in flight at that moment is lost (seen on the first
  // sync, 2026-09-13). The SDK caps a trigger at five seconds.
  await Promise.all(
    recipients.map((recipient) =>
      notifySupportTicketCreated([recipient.id], {
        ticketId: ticket.id,
        reference: ticket.referenceNumber ?? undefined,
        ticketTitle: ticket.title || "Support Ticket",
        userName: customer?.name ?? undefined,
        dashboardUrl: recipient.dashboardUrl,
        ...notificationScope(ticket.organizationId, orgName),
      }),
    ),
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
   * ticket — Novu rejects a repeated transactionId, so only the first reply
   * would ever have paged anyone.
   */
  eventId?: string,
  activity: "replied" | "reopened" = "replied",
): Promise<void> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      title: true,
      assignedToId: true,
      referenceNumber: true,
      organizationId: true,
      user: { select: { name: true } },
    },
  });
  if (!ticket) return;
  const recipients = await opsRecipients(ticketId, ticket.assignedToId);
  if (recipients.length === 0) return;
  const dedupeKey = eventId ?? `${ticketId}:${Date.now()}`;
  await Promise.all(
    recipients.map((recipient) =>
      notifySupportTicketActivity(
        [recipient.id],
        {
          ticketId,
          reference: ticket.referenceNumber ?? undefined,
          ticketTitle: ticket.title,
          userName: ticket.user.name ?? undefined,
          activity,
          dashboardUrl: recipient.dashboardUrl,
          ...notificationScope(organizationId ?? ticket.organizationId),
        },
        dedupeKey,
      ),
    ),
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
    SupportTicket,
    | "id"
    | "title"
    | "referenceNumber"
    | "userId"
    | "ackDueAt"
    | "createdAt"
    | "organizationId"
  >,
): Promise<void> {
  const reference = ticket.referenceNumber ?? ticket.id;
  const title = ticket.title || "Support Ticket";
  const slaWindow = slaWindowOf(ticket.createdAt, ticket.ackDueAt);
  const ticketUrl = supportRequestHref(
    caseKeyOf({ kind: "ticket", id: ticket.id }),
    ticket.organizationId,
  );

  const novuOutbox = await stageTrigger({
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_RECEIVED,
    kind: "SINGLE",
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
    novuOutbox ? attemptTrigger(novuOutbox).catch(() => undefined) : undefined,
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
): Promise<SupportTicket> {
  const priority = input.priority ?? "MEDIUM";
  const body = stripCallbackTags(input.description).trim();
  const description = input.callbackPhone
    ? `[Callback Requested: ${input.callbackPhone}]\n\n${body}`
    : body;
  // One transaction so a rolled-back ticket cannot leave a live reference
  // behind, and so the SLA clock and the row it belongs to commit together.
  const ticket = await prisma.$transaction(
    async (tx) => {
      const openedAt = new Date();
      const referenceNumber = await allocateTicketReference(tx, openedAt);
      const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, openedAt);
      return tx.supportTicket.create({
        data: {
          title: input.title,
          description,
          priority,
          referenceNumber,
          ackDueAt,
          resolutionDueAt,
          category: input.category ?? undefined,
          issueType: input.issueType ?? undefined,
          consultationId: input.consultationId ?? undefined,
          subscriptionId: input.subscriptionId ?? undefined,
          paymentId: input.paymentId ?? undefined,
          organizationId: input.organizationId ?? undefined,
          // A ticket is born from a message (its description) — start the
          // last-activity clock at creation.
          lastMessageAt: openedAt,
          userId: input.userId,
        },
        include: { responses: true, attachments: true },
      });
    },
    // The counter row is a serialization point: concurrent creates queue on it,
    // so this transaction gets the repo's allocation budget rather than the
    // default, exactly as ALLOCATION_TX_* was named for.
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
  // The ticket is already committed — a notification failure must not turn a
  // successful create into a 500, or the retrying client files a duplicate.
  await Promise.all([
    notifySupportStaff(ticket).catch((error) => {
      console.error("support: staff notification failed", {
        ticketId: ticket.id,
        error,
      });
    }),
    input.filedBy === "requester"
      ? notifyRequesterOfTicket(ticket).catch((error) => {
          console.error("support: requester receipt failed", {
            ticketId: ticket.id,
            error,
          });
        })
      : undefined,
  ]);
  return ticket;
}

/**
 * Best-effort escalation dedup for the platform intake: a replayed terminal
 * turn (double-click, client retry) reuses the user's still-OPEN ticket for
 * the same flow outcome instead of filing a twin. Runtime check, not a schema
 * unique — the schema is frozen (#705) and the same issue type may legitimately
 * recur once resolved, so the window is bounded. The lookup+create race window
 * is accepted (low volume; worst case one duplicate, same as pre-helper).
 */
export async function findRecentOpenEscalation(
  userId: string,
  issueType: SupportIssueType,
  organizationId: string | null,
): Promise<SupportTicket | null> {
  const dedupeWindow = new Date(Date.now() - 30 * 60_000);
  return prisma.supportTicket.findFirst({
    where: {
      userId,
      issueType,
      // Pass through directly: null must FILTER on organizationId: null (B2C
      // replays dedupe against B2C tickets only), not omit the constraint.
      organizationId,
      status: "OPEN",
      createdAt: { gte: dedupeWindow },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Dedup: a payment-linked ticket reuses any still-open ticket the user already
 * filed for the same payment. Runtime check (not a schema unique) — a payment
 * can legitimately spawn a second ticket once the first is RESOLVED/CLOSED.
 */
export async function findOpenTicketForPayment(
  userId: string,
  paymentId: string,
) {
  const ticket = await prisma.supportTicket.findFirst({
    where: {
      paymentId,
      userId,
      status: { notIn: ["RESOLVED", "CLOSED"] },
    },
    include: {
      responses: {
        where: { isInternal: false },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { name: true, role: true } } },
      },
      attachments: { orderBy: { uploadedAt: "desc" } },
    },
  });
  return ticket
    ? { ...ticket, attachments: withSupportAttachmentHrefs(ticket.attachments) }
    : null;
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
): Promise<SupportTicket | null> {
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

  const ticketUserId = targetUser.id;
  const [validMembership, validPayment] = await Promise.all([
    input.organizationId
      ? prisma.membership.findFirst({
          where: {
            organizationId: input.organizationId,
            userId: ticketUserId,
            status: "ACTIVE",
          },
          select: { organizationId: true },
        })
      : null,
    input.paymentId
      ? prisma.payment.findFirst({
          where: {
            id: input.paymentId,
            userId: ticketUserId,
          },
          select: { id: true },
        })
      : null,
  ]);

  const resolvedOrganizationId = validMembership?.organizationId ?? null;
  const resolvedPaymentId = validPayment?.id ?? null;
  const priority = input.priority ?? "MEDIUM";
  // The callback marker is server-written from a validated phone only; staff free text never carries one.
  const description = stripCallbackTags(input.description).trim();

  const ticket = await prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const referenceNumber = await allocateTicketReference(tx, now);
      const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, now);

      const created = await tx.supportTicket.create({
        data: {
          userId: ticketUserId,
          assignedToId: input.staffUserId,
          status: "IN_PROGRESS",
          title: input.title,
          description,
          priority,
          referenceNumber,
          ackDueAt,
          resolutionDueAt,
          acknowledgedAt: now,
          firstAgentReplyAt: now,
          awaitingUserSince: now,
          lastMessageAt: now,
          category: input.category ?? undefined,
          issueType: input.issueType ?? "GENERAL_INQUIRY",
          organizationId: resolvedOrganizationId ?? undefined,
          paymentId: resolvedPaymentId ?? undefined,
        },
      });

      await tx.supportResponse.create({
        data: {
          message: description,
          isInternal: false,
          supportTicket: { connect: { id: created.id } },
          user: { connect: { id: input.staffUserId } },
        },
      });

      return created;
    },
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );

  await notifySupportTicketResponse(ticket.userId, {
    ticketId: ticket.id,
    reference: ticket.referenceNumber ?? undefined,
    ticketTitle: ticket.title || "Support Ticket",
    message: description,
    respondedBy: input.staffUserName ?? "Support",
    dashboardUrl: supportRequestHref(
      caseKeyOf({ kind: "ticket", id: ticket.id }),
      resolvedOrganizationId,
    ),
    ...notificationScope(resolvedOrganizationId),
  }).catch((err) => {
    reportSentryError(err, {
      subsystem: "support",
      op: "outbound.notifyUser",
      extra: { ticketId: ticket.id },
    });
  });

  return ticket;
}
