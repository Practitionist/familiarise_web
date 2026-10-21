/** Shared case intake and notifications for platform and appointment help. */

import prisma, { type PrismaLike } from "@/lib/prisma";
import type {
  SupportIssueType,
  SupportPriority,
  SupportCase,
} from "@prisma/client";
import { stripCallbackTags } from "@/lib/validation/phone";
import { createOrReuseSupportCase } from "./case-service";

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
  appointmentId?: string | null;
  clientIntakeId?: string;
  /** Org attribution (operator intake / escalated org threads). Null = B2C. */
  organizationId?: string | null;
  /** Only a ticket the requester filed themselves earns them a "request received" receipt. */
  filedBy: "requester" | "system";
}

/**
 * Create a support ticket + notify the ops queue. Callers own validation and
 * dedup (e.g. the paymentId dedup is a route-level UX decision).
 */
export async function createSupportTicket(
  input: CreateSupportTicketInput,
): Promise<SupportCase> {
  const result = await createOrReuseSupportCase({
    clientIntakeId: input.clientIntakeId,
    requesterUserId: input.userId,
    submitterUserId: input.userId,
    title: input.title,
    description: stripCallbackTags(input.description).trim(),
    initialSender: input.filedBy === "system" ? "SYSTEM" : "USER",
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
      status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED"] },
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
    submitterUserId: targetUser.id,
    initialSender: "AGENT",
    initialAuthorUserId: input.staffUserId,
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
  return supportCase;
}
