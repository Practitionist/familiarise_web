import type { SupportCaseOwnership, SupportCaseStatus } from "@prisma/client";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { stageBell } from "@/lib/novu/stage-bell";
import type { StagedTrigger } from "@/lib/novu/outbox";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { stageSupportTicketUpdateEmail } from "@/lib/email/senders/people";
import { caseCorrespondentIds } from "./case-access";
import { releaseAllCaseHolds } from "./case-holds";
import { caseKeyOf } from "./case-key";
import { stageCaseResolutionCsatPromptTx } from "./case-service";
import { stageExternalRequesterEmail } from "./external-requester";
import { userRepliedPatch } from "./sla";

interface OpenIncident {
  id: string;
  referenceNumber: string;
  title: string;
  submitterUserId: string;
  requesterUserId: string;
  organizationId: string | null;
  ownershipScope: SupportCaseOwnership;
  externalRequesterEmail: string | null;
  status: SupportCaseStatus;
  messageSeq: number;
  awaitingUserSince: Date | null;
  pausedSeconds: number;
  problemCaseId: string | null;
  problemCase: { referenceNumber: string } | null;
}

interface StagedNotices {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

interface ProblemCascadeResult extends StagedNotices {
  cascaded: number;
}

const RESOLVED_LABEL = supportTicketStatusLabel("RESOLVED");

/** Stages the customer's RESOLVED status bell and email on the incident's own transaction. */
async function stageResolvedNoticeTx(
  tx: Tx,
  inc: OpenIncident,
  now: Date,
  out: StagedNotices,
): Promise<void> {
  const entityRef = `case-status:${inc.id}:RESOLVED:${now.getTime()}`;
  if (inc.externalRequesterEmail) {
    out.emails.push(
      await stageExternalRequesterEmail(
        {
          caseId: inc.id,
          reference: inc.referenceNumber,
          to: inc.externalRequesterEmail,
          subject: `Support update — ${inc.referenceNumber}`,
          text: `Reference: ${inc.referenceNumber}. Status: ${RESOLVED_LABEL}.`,
          emailType: "SUPPORT_TICKET_UPDATE",
          entityRef,
        },
        tx,
      ),
    );
    return;
  }
  const recipients = await caseCorrespondentIds(inc, tx);
  const dashboardUrl = supportRequestHref(
    caseKeyOf({ kind: "case", id: inc.id }),
    inc.organizationId,
  );
  const bell = await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients,
    dedupeKey: entityRef,
    entityRef,
    payload: {
      ticketId: inc.id,
      reference: inc.referenceNumber,
      ticketTitle: inc.title,
      status: RESOLVED_LABEL,
      statusCode: "RESOLVED",
      dashboardUrl,
      ...notificationScope(inc.organizationId),
    },
  });
  if (bell) out.bells.push(bell);
  // One connection per transaction: stage each recipient's email in turn.
  for (const recipientId of recipients) {
    out.emails.push(
      ...(await stageSupportTicketUpdateEmail(tx, {
        ticketId: inc.id,
        ownerUserId: recipientId,
        reference: inc.referenceNumber,
        title:
          inc.ownershipScope === "PERSONAL"
            ? inc.title
            : "Organization support request",
        statusCode: "RESOLVED",
        statusLabel: RESOLVED_LABEL,
        ticketUrl: dashboardUrl,
      })),
    );
  }
}

/** Resolves one incident; the CAS re-checks the problem is still RESOLVED. */
async function resolveIncidentTx(
  tx: Tx,
  inc: OpenIncident,
  now: Date,
  out: StagedNotices,
): Promise<boolean> {
  if (!inc.problemCaseId) return false;
  const resolution = await tx.supportCaseEvent.findFirst({
    where: {
      caseId: inc.problemCaseId,
      kind: "STATUS_CHANGED",
      toValue: "RESOLVED",
    },
    orderBy: { createdAt: "desc" },
    select: { actorId: true, note: true },
  });
  const actorId = resolution?.actorId ?? null;
  const closingMsg = resolution?.note?.trim() || null;
  const bankedPause =
    inc.awaitingUserSince !== null ? userRepliedPatch(inc, now) : {};
  const moved = await tx.supportCase.updateMany({
    where: {
      id: inc.id,
      status: inc.status,
      messageSeq: inc.messageSeq,
      awaitingUserSince: inc.awaitingUserSince,
      pausedSeconds: inc.pausedSeconds,
      problemCaseId: inc.problemCaseId,
      problemCase: { status: "RESOLVED", deletedAt: null },
    },
    data: {
      status: "RESOLVED",
      resolvedAt: now,
      closedAt: null,
      ...bankedPause,
      ...(closingMsg
        ? { messageSeq: { increment: 1 }, lastMessageAt: now }
        : {}),
    },
  });
  if (moved.count === 0) return false;

  if (closingMsg) {
    await tx.supportCaseMessage.create({
      data: {
        caseId: inc.id,
        seq: inc.messageSeq + 1,
        sender: "AGENT",
        body: closingMsg,
        isInternal: false,
        authorUserId: actorId,
        createdAt: now,
      },
    });
  }
  await tx.supportCaseEvent.create({
    data: {
      caseId: inc.id,
      actorId,
      kind: "STATUS_CHANGED",
      fromValue: inc.status,
      toValue: "RESOLVED",
      note: `Resolved via problem ${inc.problemCase?.referenceNumber ?? inc.problemCaseId}`,
      createdAt: now,
    },
  });
  await releaseAllCaseHolds(tx, {
    caseId: inc.id,
    actorId,
    note: "Released when the case was resolved",
  });
  await stageResolvedNoticeTx(tx, inc, now, out);
  await stageCaseResolutionCsatPromptTx(tx, inc, now);
  return true;
}

/**
 * Resolves up to `limit` open incidents whose problem is RESOLVED, oldest first,
 * one short transaction each; failures go to `errors` and retry next run.
 */
export async function cascadeResolvedProblems({
  limit,
  now,
  errors,
}: {
  limit: number;
  now: Date;
  errors: string[];
}): Promise<ProblemCascadeResult> {
  const result: ProblemCascadeResult = { cascaded: 0, bells: [], emails: [] };
  if (limit <= 0) return result;
  let incidents: OpenIncident[];
  try {
    incidents = await prisma.supportCase.findMany({
      where: {
        caseKind: "INCIDENT",
        status: { notIn: ["RESOLVED", "CLOSED"] },
        deletedAt: null,
        problemCase: { status: "RESOLVED", deletedAt: null },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        submitterUserId: true,
        requesterUserId: true,
        organizationId: true,
        ownershipScope: true,
        externalRequesterEmail: true,
        status: true,
        messageSeq: true,
        awaitingUserSince: true,
        pausedSeconds: true,
        problemCaseId: true,
        problemCase: { select: { referenceNumber: true } },
      },
    });
  } catch (err) {
    errors.push(
      `problem-cascade scan: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // Sequential: each incident commits on its own before the next starts.
  for (const inc of incidents) {
    const staged: StagedNotices = { bells: [], emails: [] };
    try {
      const resolved = await prisma.$transaction(
        (tx) => resolveIncidentTx(tx, inc, now, staged),
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
      if (!resolved) continue;
      result.cascaded += 1;
      result.bells.push(...staged.bells);
      result.emails.push(...staged.emails);
    } catch (err) {
      errors.push(
        `problem-cascade incident ${inc.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}
