/**
 * The one writer for a consultant verification submission — onboarding
 * completion, `POST /api/verification/submit` and `/resubmit` all call this.
 * Three copies used to disagree (onboarding superseded the open row, the
 * settings submit updated it in place, resubmit created a second one) and
 * none held a transaction, so two concurrent calls produced two PENDING
 * rows, and onboarding linked any document id it was handed (#1224).
 *
 * Inside one Serializable transaction:
 *   1. CAS the profile from PENDING_VERIFICATION / REJECTED to UNDER_REVIEW —
 *      a second caller loses with NOT_SUBMITTABLE instead of a duplicate row.
 *   2. Supersede the open PENDING / NEEDS_INFO request (append-only history:
 *      a round is a row).
 *   3. Link only documents the caller uploaded and has not linked yet.
 *   4. Carry over the previous request's documents that were not flagged, so
 *      the consultant re-uploads only what staff marked invalid.
 *   5. Refuse a request that would end up with no document at all.
 *   6. Stage the admin "new application" bells in the same transaction.
 * The vendor attempts are the caller's job, after commit.
 * See docs/onboarding/04-verification-lifecycle.md.
 */

import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import type { StagedTrigger } from "@/lib/novu";
import { stageNewApplicationBells } from "./notify-admins";

export interface SubmitVerificationInput {
  userId: string;
  consultantProfileId: string;
  notes?: string | null;
  linkedinUrl?: string | null;
  /** Ids of the caller's own unlinked uploads to attach. */
  documentIds: string[];
  /** Move the previous request's unflagged documents onto the new one. */
  carryOver: boolean;
  /** Where the admin bell points; the bells are staged inside the transaction. */
  adminDashboardUrl: string;
}

export type SubmitRefusalCode =
  | "PROFILE_NOT_FOUND"
  | "NOT_SUBMITTABLE"
  | "DOCUMENTS_NOT_OWNED"
  | "NO_DOCUMENTS";

export type SubmitVerificationOutcome =
  | {
      ok: true;
      verificationId: string;
      /** 1 for a first submission; +1 per answered NEEDS_INFO since the last decision. */
      round: number;
      documentCount: number;
      supersededId: string | null;
      /** Admin "new application" bells, staged in the transaction; attempt after commit. */
      staged: StagedTrigger[];
    }
  | { ok: false; code: SubmitRefusalCode; message: string };

export const SUBMIT_REFUSAL_STATUS: Record<SubmitRefusalCode, number> = {
  PROFILE_NOT_FOUND: 404,
  NOT_SUBMITTABLE: 409,
  DOCUMENTS_NOT_OWNED: 403,
  NO_DOCUMENTS: 400,
};

class SubmitRefused extends Error {
  constructor(
    readonly code: SubmitRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** Rounds since the last APPROVED / REJECTED decision — a NEEDS_INFO that was answered is a SUPERSEDED row with a reviewedAt. */
export async function countAnsweredRounds(
  db: Pick<Tx, "consultantProfileVerification">,
  consultantProfileId: string,
): Promise<number> {
  const lastDecision = await db.consultantProfileVerification.findFirst({
    where: {
      consultantProfileId,
      status: { in: ["APPROVED", "REJECTED"] },
    },
    orderBy: { reviewedAt: "desc" },
    select: { reviewedAt: true },
  });
  return db.consultantProfileVerification.count({
    where: {
      consultantProfileId,
      status: { in: ["NEEDS_INFO", "SUPERSEDED"] },
      reviewedAt: { not: null },
      ...(lastDecision?.reviewedAt
        ? { createdAt: { gt: lastDecision.reviewedAt } }
        : {}),
    },
  });
}

export async function submitVerificationRequest(
  input: SubmitVerificationInput,
): Promise<SubmitVerificationOutcome> {
  const documentIds = Array.from(new Set(input.documentIds));
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const profile = await tx.consultantProfile.findUnique({
            where: { id: input.consultantProfileId },
            select: { userId: true, verificationStatus: true },
          });
          if (profile?.userId !== input.userId) {
            throw new SubmitRefused(
              "PROFILE_NOT_FOUND",
              "Consultant profile not found",
            );
          }

          // 1. CAS the profile status. UNDER_REVIEW means a submission is
          // already in the queue; VERIFIED has nothing to submit.
          const claimed = await tx.consultantProfile.updateMany({
            where: {
              id: input.consultantProfileId,
              verificationStatus: { in: ["PENDING_VERIFICATION", "REJECTED"] },
            },
            data: { verificationStatus: "UNDER_REVIEW", isVerified: false },
          });
          if (claimed.count === 0) {
            throw new SubmitRefused(
              "NOT_SUBMITTABLE",
              profile.verificationStatus === "VERIFIED"
                ? "Your profile is already verified"
                : "A verification request is already under review",
            );
          }

          // 2. Supersede the open request (there is at most one).
          const previous = await tx.consultantProfileVerification.findFirst({
            where: {
              consultantProfileId: input.consultantProfileId,
              status: { in: ["PENDING", "NEEDS_INFO"] },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          // Carry-over may also come from the last REJECTED request.
          const carrySource =
            previous ??
            (input.carryOver
              ? await tx.consultantProfileVerification.findFirst({
                  where: {
                    consultantProfileId: input.consultantProfileId,
                    status: "REJECTED",
                  },
                  orderBy: { reviewedAt: "desc" },
                  select: { id: true },
                })
              : null);
          if (previous) {
            await tx.consultantProfileVerification.updateMany({
              where: {
                id: previous.id,
                status: { in: ["PENDING", "NEEDS_INFO"] },
              },
              data: { status: "SUPERSEDED" },
            });
          }

          const round =
            (await countAnsweredRounds(tx, input.consultantProfileId)) + 1;

          const created = await tx.consultantProfileVerification.create({
            data: {
              consultantProfileId: input.consultantProfileId,
              status: "PENDING",
              notes: input.notes ?? null,
            },
            select: { id: true },
          });

          // 3. Link only what the caller uploaded and has not linked (#1224).
          if (documentIds.length > 0) {
            const linked = await tx.profileVerificationDocument.updateMany({
              where: {
                id: { in: documentIds },
                uploadedByUserId: input.userId,
                verificationId: null,
              },
              data: { verificationId: created.id, linkedAt: new Date() },
            });
            if (linked.count !== documentIds.length) {
              throw new SubmitRefused(
                "DOCUMENTS_NOT_OWNED",
                "One or more documents are not yours or were already submitted",
              );
            }
          }

          // 4. Carry over the unflagged documents of the previous request.
          if (input.carryOver && carrySource) {
            await tx.profileVerificationDocument.updateMany({
              where: {
                verificationId: carrySource.id,
                issue: null,
                isValid: { not: false },
              },
              data: {
                verificationId: created.id,
                linkedAt: new Date(),
                isValid: null,
                staffFeedback: null,
              },
            });
          }

          // 5. A review needs something to review.
          const documentCount = await tx.profileVerificationDocument.count({
            where: { verificationId: created.id },
          });
          if (documentCount === 0) {
            throw new SubmitRefused(
              "NO_DOCUMENTS",
              "Attach at least one document before submitting",
            );
          }

          if (input.linkedinUrl?.trim()) {
            await tx.user.update({
              where: { id: input.userId },
              data: { linkedinUrl: input.linkedinUrl.trim() },
            });
          }

          // The queue item and its notice exist together or not at all.
          const staged = await stageNewApplicationBells(
            { userId: input.userId, dashboardUrl: input.adminDashboardUrl },
            tx,
          );

          return {
            ok: true as const,
            verificationId: created.id,
            round,
            documentCount,
            supersededId: previous?.id ?? null,
            staged,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
  } catch (error) {
    if (error instanceof SubmitRefused) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
