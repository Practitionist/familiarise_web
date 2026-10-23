import { Prisma, type SupportCaseEventKind } from "@prisma/client";
import prisma, { ALLOCATION_TX_MAX_WAIT_MS, type Tx } from "@/lib/prisma";
import { removeObjects } from "@/lib/supabase-storage-core";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { SUPPORT_EVIDENCE_BUCKET } from "./attachment-policy";

const DAY_MS = 24 * 3_600_000;
const SUPPORT_EVIDENCE_RETENTION_MS = 180 * DAY_MS;
const PURGED_SUPPORT_TEXT = "[deleted after the retention period]";
// Titles are requester free text (a grievance title embeds its subject), so they go too.
const PURGED_SUPPORT_TITLE = "Support request";
const PURGED_ATTACHMENT_NAME = "Deleted after the retention period";
// Notes on these events are the decision, money, retention and staff-access record; every other event note is purged.
const RECORD_EVENT_KINDS: SupportCaseEventKind[] = [
  "HOLD_APPLIED",
  "HOLD_RELEASED",
  "RECOMMENDATION_PROPOSED",
  "RECOMMENDATION_DECIDED",
  "RECOMMENDATION_VOIDED",
  "DECISION_RECORDED",
  "LEGAL_HOLD_CHANGED",
  "EVIDENCE_PURGED",
  // The staff chat-access log follows the security-log period, not the 180-day purge.
  "CHAT_ACCESS_GRANTED",
  "CHAT_ACCESS_ENDED",
  "CHAT_SUPPORT_MESSAGE",
  "CHAT_REVIEW_NOTIFIED",
];
const STORAGE_BATCH = 100;
// Storage runs under the case's row lock; room for several 100-path batches and their existence re-checks.
const PURGE_TX_TIMEOUT_MS = 60_000;
// Overscan so cases that keep failing storage cannot hold the oldest slots of every run.
const PURGE_SCAN_FACTOR = 4;
// Live disputes are few; at the cap the derived-hold set may be incomplete, so the run purges nothing.
const LIVE_DISPUTE_CAP = 2_000;

interface EvidencePurgeResult {
  casesPurged: number;
  filesDeleted: number;
}

/** Ids a live chargeback reaches: its payment, that payment's booking and its refunds. */
async function liveDisputeLinks(): Promise<{
  paymentIds: string[];
  appointmentIds: string[];
  refundIds: string[];
} | null> {
  const disputes = await prisma.dispute.findMany({
    where: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
    select: {
      paymentId: true,
      payment: {
        select: { appointmentId: true, refunds: { select: { id: true } } },
      },
    },
    take: LIVE_DISPUTE_CAP,
  });
  if (disputes.length >= LIVE_DISPUTE_CAP) return null;
  return {
    paymentIds: [...new Set(disputes.map((d) => d.paymentId))],
    appointmentIds: [
      ...new Set(
        disputes.flatMap((d) =>
          d.payment.appointmentId ? [d.payment.appointmentId] : [],
        ),
      ),
    ],
    refundIds: [
      ...new Set(disputes.flatMap((d) => d.payment.refunds.map((r) => r.id))),
    ],
  };
}

/**
 * Cases whose evidence is past retention: closed 180 days ago, as is every
 * appeal on their decisions (and, for an appeal, the original case); no legal
 * hold, no live dispute on a linked payment, not purged yet.
 */
function purgeEligibleWhere(
  cutoff: Date,
  links: {
    paymentIds: string[];
    appointmentIds: string[];
    refundIds: string[];
  },
): Prisma.SupportCaseWhereInput {
  const disputedSubjects: Prisma.SupportCaseSubjectWhereInput[] = [
    ...(links.paymentIds.length
      ? [
          {
            subjectType: "PAYMENT" as const,
            subjectId: { in: links.paymentIds },
          },
        ]
      : []),
    ...(links.appointmentIds.length
      ? [
          {
            subjectType: "APPOINTMENT" as const,
            subjectId: { in: links.appointmentIds },
          },
        ]
      : []),
    ...(links.refundIds.length
      ? [{ subjectType: "REFUND" as const, subjectId: { in: links.refundIds } }]
      : []),
  ];
  return {
    closedAt: { lte: cutoff },
    legalHoldAt: null,
    // Purged once: content added after a staff reopen of a purged case is not purged again.
    events: { none: { kind: "EVIDENCE_PURGED" } },
    decisions: {
      none: {
        appeals: {
          some: { OR: [{ closedAt: null }, { closedAt: { gt: cutoff } }] },
        },
      },
    },
    AND: [
      {
        OR: [
          { appealOfDecisionId: null },
          { appealOfDecision: { supportCase: { closedAt: { lte: cutoff } } } },
        ],
      },
      ...(links.appointmentIds.length
        ? [
            {
              OR: [
                { appointmentId: null },
                { appointmentId: { notIn: links.appointmentIds } },
              ],
            },
          ]
        : []),
    ],
    ...(disputedSubjects.length
      ? { subjects: { none: { OR: disputedSubjects } } }
      : {}),
    ...(links.paymentIds.length
      ? {
          recommendations: { none: { paymentId: { in: links.paymentIds } } },
        }
      : {}),
  };
}

/** True only when every object is confirmed gone from the bucket. */
async function removeCaseObjects(paths: string[]): Promise<boolean> {
  // Sequential batches keep the storage API within its per-call limit.
  for (let i = 0; i < paths.length; i += STORAGE_BATCH) {
    if (
      !(await removeObjects(
        SUPPORT_EVIDENCE_BUCKET,
        paths.slice(i, i + STORAGE_BATCH),
      ))
    )
      return false;
  }
  return true;
}

type PurgeCandidate = { id: string };

/** The eligibility filter and the oldest candidates, or null when the run must not purge. */
async function scanPurgeCandidates(
  now: Date,
  take: number,
  errors: string[],
): Promise<{
  eligible: Prisma.SupportCaseWhereInput;
  cases: PurgeCandidate[];
} | null> {
  try {
    const links = await liveDisputeLinks();
    if (!links) {
      errors.push(
        `evidence-purge: ${LIVE_DISPUTE_CAP}+ live disputes; purge skipped this run`,
      );
      return null;
    }
    const eligible = purgeEligibleWhere(
      new Date(now.getTime() - SUPPORT_EVIDENCE_RETENTION_MS),
      links,
    );
    const cases = await prisma.supportCase.findMany({
      where: eligible,
      orderBy: [{ closedAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true },
    });
    return { eligible, cases };
  } catch (err) {
    errors.push(
      `evidence-purge scan: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Scrubs one locked, eligible case after its files are gone. */
async function scrubPurgedCaseTx(
  tx: Tx,
  caseId: string,
  fileCount: number,
  now: Date,
): Promise<void> {
  await tx.supportCase.update({
    where: { id: caseId },
    data: {
      title: PURGED_SUPPORT_TITLE,
      description: PURGED_SUPPORT_TEXT,
      callbackPhone: null,
      callbackWindow: null,
      externalRequesterEmail: null,
      externalRequesterName: null,
    },
  });
  await tx.supportCaseAttachment.updateMany({
    where: { caseId, deletedAt: null },
    data: { deletedAt: now },
  });
  await tx.supportCaseAttachment.updateMany({
    where: { caseId },
    data: { originalName: PURGED_ATTACHMENT_NAME },
  });
  await tx.supportCaseMessage.updateMany({
    where: { caseId },
    data: { body: PURGED_SUPPORT_TEXT, metadata: Prisma.DbNull },
  });
  await tx.supportCaseEvidenceRequest.updateMany({
    where: { caseId },
    data: { prompt: PURGED_SUPPORT_TEXT },
  });
  await tx.supportCaseEvidenceRequest.updateMany({
    where: { caseId, responseBody: { not: null } },
    data: { responseBody: PURGED_SUPPORT_TEXT },
  });
  await tx.supportCaseEvent.updateMany({
    where: {
      caseId,
      note: { not: null },
      kind: { notIn: RECORD_EVENT_KINDS },
    },
    data: { note: null },
  });
  await tx.supportCaseEvent.create({
    data: {
      caseId,
      kind: "EVIDENCE_PURGED",
      toValue: String(fileCount),
      createdAt: now,
    },
  });
}

type CasePurgeOutcome =
  | { kind: "ineligible" }
  | { kind: "storage-failed"; fileCount: number }
  | { kind: "purged"; fileCount: number };

/**
 * Locks the case row, so a legal-hold PATCH waits, re-checks eligibility, then
 * deletes the files and scrubs the text before the lock is released.
 */
async function purgeLockedCaseTx(
  tx: Tx,
  caseId: string,
  eligible: Prisma.SupportCaseWhereInput,
  now: Date,
): Promise<CasePurgeOutcome> {
  await tx.$executeRaw`SELECT id FROM "SupportCase" WHERE id = ${caseId} FOR UPDATE`;
  const stillEligible = await tx.supportCase.count({
    where: { id: caseId, ...eligible },
  });
  if (stillEligible === 0) return { kind: "ineligible" };
  const attachments = await tx.supportCaseAttachment.findMany({
    where: { caseId },
    select: { storagePath: true },
  });
  const paths = attachments.map((a) => a.storagePath);
  // Nothing is written yet, so a storage failure leaves the case whole for the next run.
  if (!(await removeCaseObjects(paths)))
    return { kind: "storage-failed", fileCount: paths.length };
  await scrubPurgedCaseTx(tx, caseId, paths.length, now);
  return { kind: "purged", fileCount: paths.length };
}

/** Purges one case; the number of files deleted, or null when it was skipped or failed. */
async function purgeCase(
  c: PurgeCandidate,
  eligible: Prisma.SupportCaseWhereInput,
  now: Date,
  errors: string[],
): Promise<number | null> {
  try {
    const outcome = await prisma.$transaction(
      (tx) => purgeLockedCaseTx(tx, c.id, eligible, now),
      { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: PURGE_TX_TIMEOUT_MS },
    );
    if (outcome.kind === "purged") return outcome.fileCount;
    if (outcome.kind === "storage-failed")
      errors.push(
        `evidence-purge case ${c.id}: ${outcome.fileCount} file(s) not confirmed deleted`,
      );
    return null;
  } catch (err) {
    errors.push(
      `evidence-purge case ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Deletes the files and personal free text of support cases past the 180-day
 * retention, keeping the case skeleton, decisions, money-event notes and payment links. A case
 * whose files are not confirmed deleted keeps its text and is retried next run.
 */
export async function purgeExpiredSupportEvidence({
  limit,
  now,
  errors,
}: {
  limit: number;
  now: Date;
  errors: string[];
}): Promise<EvidencePurgeResult> {
  const result: EvidencePurgeResult = { casesPurged: 0, filesDeleted: 0 };
  if (limit <= 0) return result;
  const scan = await scanPurgeCandidates(
    now,
    limit * PURGE_SCAN_FACTOR,
    errors,
  );
  if (!scan) return result;

  // One case per transaction, one transaction at a time.
  for (const c of scan.cases) {
    if (result.casesPurged >= limit) break;
    const filesDeleted = await purgeCase(c, scan.eligible, now, errors);
    if (filesDeleted === null) continue;
    result.casesPurged += 1;
    result.filesDeleted += filesDeleted;
  }
  return result;
}
