import { Prisma } from "@prisma/client";
import type { Db, Tx } from "@/lib/prisma";
import { SUPPORT_EVIDENCE_BUCKET } from "./attachment-policy";

export const ERASED_SUPPORT_TEXT = "[erased]";

/**
 * Support rows that a hard delete cannot remove: decisions, evidence,
 * recommendations, holds and attachments restrict their case and author. An
 * account with any of these takes the scrub path instead.
 */
export async function supportRetainedHistoryCount(
  db: Pick<
    Db,
    | "supportCase"
    | "supportCaseEvidenceRequest"
    | "supportCaseAttachment"
    | "supportCaseDecision"
    | "supportFinancialRecommendation"
    | "supportPaymentHold"
  >,
  userId: string,
): Promise<number> {
  const [cases, evidence, attachments, decisions, recommendations, holds] =
    await Promise.all([
      db.supportCase.count({
        where: {
          OR: [{ requesterUserId: userId }, { submitterUserId: userId }],
          AND: {
            OR: [
              { decisions: { some: {} } },
              { evidenceRequests: { some: {} } },
              { attachments: { some: {} } },
              { recommendations: { some: {} } },
              { paymentHolds: { some: {} } },
            ],
          },
        },
      }),
      db.supportCaseEvidenceRequest.count({
        where: {
          OR: [{ recipientUserId: userId }, { requestedById: userId }],
        },
      }),
      db.supportCaseAttachment.count({ where: { uploadedById: userId } }),
      db.supportCaseDecision.count({ where: { decidedById: userId } }),
      db.supportFinancialRecommendation.count({
        where: { OR: [{ proposedById: userId }, { decidedById: userId }] },
      }),
      db.supportPaymentHold.count({
        where: { OR: [{ appliedById: userId }, { releasedById: userId }] },
      }),
    ]);
  return cases + evidence + attachments + decisions + recommendations + holds;
}

/**
 * Redacts the user's support free text and contact details inside the scrub
 * transaction and returns their attachment paths for deletion after commit.
 * Decision explanations stay: the database keeps decisions immutable.
 */
export async function scrubSupportPiiTx(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<string[]> {
  const ownCases = {
    OR: [{ requesterUserId: userId }, { submitterUserId: userId }],
  };
  await tx.supportCase.updateMany({
    where: ownCases,
    data: {
      title: "Erased support request",
      description: ERASED_SUPPORT_TEXT,
      callbackPhone: null,
      callbackWindow: null,
      externalRequesterEmail: null,
      externalRequesterName: null,
    },
  });
  await tx.supportCaseMessage.updateMany({
    where: {
      OR: [
        { authorUserId: userId },
        {
          authorUserId: null,
          sender: "USER",
          supportCase: { submitterUserId: userId, ownershipScope: "PERSONAL" },
        },
      ],
    },
    data: { body: ERASED_SUPPORT_TEXT, metadata: Prisma.DbNull },
  });
  await tx.supportCaseEvidenceRequest.updateMany({
    where: { recipientUserId: userId, responseBody: { not: null } },
    data: { responseBody: ERASED_SUPPORT_TEXT },
  });
  const attachments = await tx.supportCaseAttachment.findMany({
    where: { uploadedById: userId },
    select: { storagePath: true },
  });
  await tx.supportCaseAttachment.updateMany({
    where: { uploadedById: userId, deletedAt: null },
    data: { deletedAt: now, originalName: ERASED_SUPPORT_TEXT },
  });
  return attachments.map((a) => a.storagePath);
}

/** Every storage path the user ever uploaded as support evidence. */
export async function supportAttachmentPaths(
  db: Pick<Db, "supportCaseAttachment">,
  userId: string,
): Promise<string[]> {
  const rows = await db.supportCaseAttachment.findMany({
    where: { uploadedById: userId },
    select: { storagePath: true },
  });
  return rows.map((row) => row.storagePath);
}

/** Deletes the objects after commit; a failure line asks for a re-run. */
export async function removeSupportAttachmentObjects(
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const { removeObjects } = await import("@/lib/supabase-storage-core");
  const removed = await removeObjects(SUPPORT_EVIDENCE_BUCKET, paths);
  return removed
    ? []
    : [
        `support_attachments: ${paths.length} file(s) not confirmed deleted — re-run required`,
      ];
}
