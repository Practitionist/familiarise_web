import { z } from "zod";
import type { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { adminStorage } from "@/lib/supabase-storage-core";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { canCorrespondOnCase } from "./case-access";
import { CaseActionError } from "./case-actions";

export const SUPPORT_EVIDENCE_BUCKET = "support-attachments";
export const AttachmentUploadSchema = z.object({
  originalName: z.string().trim().min(1).max(200).refine(name => !/[\u0000-\u001f/\\]/.test(name), "Invalid file name"),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  fileSize: z.number().int().positive().max(20 * 1024 * 1024),
  messageId: z.string().min(1).max(64).optional(),
  evidenceRequestId: z.string().min(1).max(64).optional(),
}).refine(data => !(data.messageId && data.evidenceRequestId), "Choose one evidence parent");

export async function attachmentCaseAccess(caseId: string, actor: { userId: string; role: UserRole }, evidenceRequestId?: string) {
  const supportCase = await prisma.supportCase.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!supportCase) return null;
  const staff = hasBackofficePermission(actor.role, "tickets.manage");
  if (evidenceRequestId) {
    const request = await prisma.supportCaseEvidenceRequest.findFirst({ where: { id: evidenceRequestId, caseId } });
    if (!request || (!staff && request.recipientUserId !== actor.userId)) return null;
    return { supportCase, staff, request };
  }
  if (!await canCorrespondOnCase(supportCase, actor)) return null;
  return { supportCase, staff, request: null };
}

export async function attachmentDownload(attachmentId: string, actor: { userId: string; role: UserRole }) {
  const attachment = await prisma.supportCaseAttachment.findFirst({ where: { id: attachmentId, completedAt: { not: null }, deletedAt: null }, include: { message: { select: { isInternal: true } } } });
  if (!attachment) return null;
  const access = await attachmentCaseAccess(attachment.caseId, actor, attachment.evidenceRequestId ?? undefined);
  if (!access || (attachment.message?.isInternal && !access.staff)) return null;
  const { data, error } = await adminStorage().from(SUPPORT_EVIDENCE_BUCKET).createSignedUrl(attachment.storagePath, 60, { download: attachment.originalName });
  if (error || !data) throw new CaseActionError("STORAGE_UNAVAILABLE", "The evidence file is temporarily unavailable.", 503);
  return data.signedUrl;
}
