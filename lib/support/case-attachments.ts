import { z } from "zod";
import type { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  adminStorage,
  ensureBucketExists,
  removeObjects,
  type BucketOptions,
} from "@/lib/supabase-storage-core";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { canCorrespondOnCase } from "./case-access";
import { CaseActionError, evidenceRecipients } from "./case-actions";
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MIME_TYPES,
  SUPPORT_ATTACHMENT_SNIFF_BYTES,
  SUPPORT_EVIDENCE_BUCKET,
} from "./attachment-policy";

/** Storage enforces these on signed uploads too, so a token cannot exceed them. */
export const SUPPORT_EVIDENCE_BUCKET_OPTIONS = {
  public: false,
  fileSizeLimit: SUPPORT_ATTACHMENT_MAX_BYTES,
  allowedMimeTypes: [...SUPPORT_ATTACHMENT_MIME_TYPES],
} satisfies BucketOptions;

/** Creates the private evidence bucket or brings its limits back to policy. */
export function ensureSupportEvidenceBucket(): Promise<boolean> {
  return ensureBucketExists(
    SUPPORT_EVIDENCE_BUCKET,
    SUPPORT_EVIDENCE_BUCKET_OPTIONS,
  );
}

const HEAD_READ_TIMEOUT_MS = 5_000;

/** A direct signed upload into the policy-configured bucket, or null when storage is unavailable. */
export async function issueSignedUpload(
  storagePath: string,
): Promise<{ signedUrl: string; token: string; path: string } | null> {
  if (!(await ensureSupportEvidenceBucket())) return null;
  const { data, error } = await adminStorage()
    .from(SUPPORT_EVIDENCE_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  return error || !data ? null : data;
}

/** The first bytes of an uploaded object, or null when it cannot be read. */
export async function readAttachmentHead(
  storagePath: string,
): Promise<Uint8Array | null> {
  const { data, error } = await adminStorage()
    .from(SUPPORT_EVIDENCE_BUCKET)
    .createSignedUrl(storagePath, 60);
  if (error || !data) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const response = await fetch(data.signedUrl, {
      headers: { Range: `bytes=0-${SUPPORT_ATTACHMENT_SNIFF_BYTES - 1}` },
      cache: "no-store",
      signal: AbortSignal.timeout(HEAD_READ_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    while (length < SUPPORT_ATTACHMENT_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    await reader.cancel().catch(() => undefined);
  } catch {
    // A network failure or timeout is unverified, not a mismatch: the caller retries.
    return null;
  }
  const head = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.length;
  }
  return head.subarray(0, SUPPORT_ATTACHMENT_SNIFF_BYTES);
}

/** Removes a rejected upload's object and tombstones its pending row. */
export async function discardPendingAttachment(attachment: {
  id: string;
  storagePath: string;
}): Promise<void> {
  await removeObjects(SUPPORT_EVIDENCE_BUCKET, [attachment.storagePath]);
  await prisma.supportCaseAttachment.updateMany({
    where: { id: attachment.id, completedAt: null, deletedAt: null },
    data: { deletedAt: new Date() },
  });
}

export const AttachmentUploadSchema = z
  .object({
    originalName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((name) => !/[\p{Cc}/\\]/u.test(name), "Invalid file name"),
    mimeType: z.enum(SUPPORT_ATTACHMENT_MIME_TYPES),
    fileSize: z.number().int().positive().max(SUPPORT_ATTACHMENT_MAX_BYTES),
    messageId: z.string().min(1).max(64).optional(),
    evidenceRequestId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (data) => !(data.messageId && data.evidenceRequestId),
    "Choose one evidence parent",
  );

export async function attachmentCaseAccess(
  caseId: string,
  actor: { userId: string; role: UserRole | null },
  evidenceRequestId?: string,
) {
  const supportCase = await prisma.supportCase.findFirst({
    where: { id: caseId, deletedAt: null },
  });
  if (!supportCase) return null;
  const staff = hasBackofficePermission(actor.role, "tickets.manage");
  if (evidenceRequestId) {
    const request = await prisma.supportCaseEvidenceRequest.findFirst({
      where: { id: evidenceRequestId, caseId },
    });
    if (!request || (!staff && request.recipientUserId !== actor.userId))
      return null;
    if (!staff) {
      const recipients = await evidenceRecipients(
        prisma,
        supportCase.appointmentId,
      );
      if (!recipients.some((recipient) => recipient.id === actor.userId))
        return null;
    }
    return { supportCase, staff, request };
  }
  if (!(await canCorrespondOnCase(supportCase, actor))) return null;
  return { supportCase, staff, request: null };
}

export async function attachmentDownload(
  attachmentId: string,
  actor: { userId: string; role: UserRole | null },
) {
  const attachment = await prisma.supportCaseAttachment.findFirst({
    where: { id: attachmentId, completedAt: { not: null }, deletedAt: null },
    include: { message: { select: { isInternal: true } } },
  });
  if (!attachment) return null;
  const access = await attachmentCaseAccess(
    attachment.caseId,
    actor,
    attachment.evidenceRequestId ?? undefined,
  );
  if (!access || (attachment.message?.isInternal && !access.staff)) return null;
  const { data, error } = await adminStorage()
    .from(SUPPORT_EVIDENCE_BUCKET)
    .createSignedUrl(attachment.storagePath, 60, {
      download: attachment.originalName,
    });
  if (error || !data)
    throw new CaseActionError(
      "STORAGE_UNAVAILABLE",
      "The evidence file is temporarily unavailable.",
      503,
    );
  return data.signedUrl;
}
