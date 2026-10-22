import { Prisma } from "@prisma/client";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { removeObjects } from "@/lib/supabase-storage-core";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { SUPPORT_EVIDENCE_BUCKET } from "./attachment-policy";

const DAY_MS = 24 * 3_600_000;
const SUPPORT_EVIDENCE_RETENTION_MS = 180 * DAY_MS;
const PURGED_SUPPORT_TEXT = "[deleted after the retention period]";
// Titles are requester free text (a grievance title embeds its subject), so they go too.
const PURGED_SUPPORT_TITLE = "Support request";
const PURGED_ATTACHMENT_NAME = "Deleted after the retention period";
const STORAGE_BATCH = 100;
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

/**
 * Deletes the files and personal free text of support cases past the 180-day
 * retention, keeping the case skeleton, decisions and payment links. A case
 * whose files are not confirmed deleted is left whole and retried next run.
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
  const cutoff = new Date(now.getTime() - SUPPORT_EVIDENCE_RETENTION_MS);
  let eligible: Prisma.SupportCaseWhereInput;
  let cases: { id: string; attachments: { storagePath: string }[] }[];
  try {
    const links = await liveDisputeLinks();
    if (!links) {
      errors.push(
        `evidence-purge: ${LIVE_DISPUTE_CAP}+ live disputes; purge skipped this run`,
      );
      return result;
    }
    eligible = purgeEligibleWhere(cutoff, links);
    cases = await prisma.supportCase.findMany({
      where: eligible,
      orderBy: { closedAt: "asc" },
      take: limit,
      select: {
        id: true,
        attachments: { select: { storagePath: true } },
      },
    });
  } catch (err) {
    errors.push(
      `evidence-purge scan: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // One case at a time: storage first, then its own short transaction.
  for (const c of cases) {
    try {
      // A legal hold or appeal may have landed since the scan; files go only while still eligible.
      if (
        (await prisma.supportCase.count({
          where: { id: c.id, ...eligible },
        })) === 0
      )
        continue;
      const paths = c.attachments.map((a) => a.storagePath);
      if (!(await removeCaseObjects(paths))) {
        errors.push(
          `evidence-purge case ${c.id}: ${paths.length} file(s) not confirmed deleted`,
        );
        continue;
      }
      const purged = await prisma.$transaction(
        async (tx) => {
          await tx.supportCaseAttachment.updateMany({
            where: { caseId: c.id, deletedAt: null },
            data: { deletedAt: now },
          });
          await tx.supportCaseAttachment.updateMany({
            where: { caseId: c.id },
            data: { originalName: PURGED_ATTACHMENT_NAME },
          });
          const scrubbed = await tx.supportCase.updateMany({
            where: { id: c.id, ...eligible },
            data: {
              title: PURGED_SUPPORT_TITLE,
              description: PURGED_SUPPORT_TEXT,
              callbackPhone: null,
              callbackWindow: null,
              externalRequesterEmail: null,
              externalRequesterName: null,
            },
          });
          if (scrubbed.count === 0) return false;
          await tx.supportCaseMessage.updateMany({
            where: { caseId: c.id },
            data: { body: PURGED_SUPPORT_TEXT, metadata: Prisma.DbNull },
          });
          await tx.supportCaseEvidenceRequest.updateMany({
            where: { caseId: c.id },
            data: { prompt: PURGED_SUPPORT_TEXT },
          });
          await tx.supportCaseEvidenceRequest.updateMany({
            where: { caseId: c.id, responseBody: { not: null } },
            data: { responseBody: PURGED_SUPPORT_TEXT },
          });
          await tx.supportCaseEvent.create({
            data: {
              caseId: c.id,
              kind: "EVIDENCE_PURGED",
              toValue: String(paths.length),
              createdAt: now,
            },
          });
          return true;
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
      if (!purged) {
        errors.push(
          `evidence-purge case ${c.id}: files deleted but the case stopped being eligible before its text was scrubbed`,
        );
        continue;
      }
      result.casesPurged += 1;
      result.filesDeleted += paths.length;
    } catch (err) {
      errors.push(
        `evidence-purge case ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}
