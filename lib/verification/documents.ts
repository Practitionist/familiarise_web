/**
 * Verification-document ownership, quotas and lifecycle (PR-5 of the
 * onboarding train; #1224, CodeRabbit on #1698). A row exists from the moment
 * a file is uploaded — `verificationId` is null until a submission links it —
 * so every document has an owner (`uploadedByUserId`), can be counted against
 * the uploader's quota, can be deleted by its owner, and can be swept when
 * abandoned. See docs/onboarding/04-verification-lifecycle.md.
 */

import type { Tx } from "@/lib/prisma";

/** Lifetime bytes one user may hold in verification storage (≈ 4 full-size documents). */
export const VERIFICATION_STORAGE_QUOTA_BYTES = 40 * 1024 * 1024;
/** Unlinked (not yet submitted) uploads one user may hold at once. */
export const MAX_OUTSTANDING_UPLOADS = 5;
/** Documents one verification request may carry. */
export const MAX_DOCS_PER_VERIFICATION = 10;
/** Unlinked uploads older than this are swept (object + row). */
export const UNLINKED_UPLOAD_TTL_DAYS = 7;

export type UploadRefusalCode =
  | "QUOTA_EXCEEDED"
  | "TOO_MANY_OUTSTANDING"
  | "TOO_MANY_PER_REQUEST";

export interface UploadRefusal {
  code: UploadRefusalCode;
  message: string;
}

/** Pure decision so the route and the tests share it. */
export function decideUploadAdmission(input: {
  incomingBytes: number;
  ownedBytes: number;
  outstandingUnlinked: number;
  linkedToTarget: number;
  linkingToRequest: boolean;
}): UploadRefusal | null {
  if (
    input.ownedBytes + input.incomingBytes >
    VERIFICATION_STORAGE_QUOTA_BYTES
  ) {
    return {
      code: "QUOTA_EXCEEDED",
      message: `You have used your ${Math.round(
        VERIFICATION_STORAGE_QUOTA_BYTES / (1024 * 1024),
      )} MB of verification storage. Delete a document you no longer need.`,
    };
  }
  if (input.linkingToRequest) {
    if (input.linkedToTarget >= MAX_DOCS_PER_VERIFICATION) {
      return {
        code: "TOO_MANY_PER_REQUEST",
        message: `Maximum ${MAX_DOCS_PER_VERIFICATION} documents per verification request. Delete an existing document before uploading a new one.`,
      };
    }
  } else if (input.outstandingUnlinked >= MAX_OUTSTANDING_UPLOADS) {
    return {
      code: "TOO_MANY_OUTSTANDING",
      message: `You already have ${MAX_OUTSTANDING_UPLOADS} uploads waiting to be submitted. Submit or remove them before adding more.`,
    };
  }
  return null;
}

type DocsDb = Pick<Tx, "profileVerificationDocument">;

/** Load the counters the admission decision needs, through the caller's `db`. */
export async function loadUploadCounters(
  db: DocsDb,
  userId: string,
  targetVerificationId: string | null,
): Promise<{
  ownedBytes: number;
  outstandingUnlinked: number;
  linkedToTarget: number;
}> {
  const [owned, outstandingUnlinked, linkedToTarget] = await Promise.all([
    db.profileVerificationDocument.aggregate({
      where: { uploadedByUserId: userId },
      _sum: { fileSize: true },
    }),
    db.profileVerificationDocument.count({
      where: { uploadedByUserId: userId, verificationId: null },
    }),
    targetVerificationId
      ? db.profileVerificationDocument.count({
          where: { verificationId: targetVerificationId },
        })
      : Promise.resolve(0),
  ]);
  return {
    ownedBytes: owned._sum.fileSize ?? 0,
    outstandingUnlinked,
    linkedToTarget,
  };
}

/** The app-relative path the UI opens; the route streams the object after an ACL check. */
export function documentDownloadPath(documentId: string): string {
  return `/api/verification/documents/${documentId}/download`;
}
