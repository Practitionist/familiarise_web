import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { adminStorage } from "@/lib/supabase-storage-core";
import { assertBodySize } from "@/lib/validation/limits";
import { documentUploadLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  AttachmentUploadSchema,
  attachmentCaseAccess,
  SUPPORT_EVIDENCE_BUCKET,
} from "@/lib/support/case-attachments";
import { supportError } from "@/lib/api/support-http";
interface Context {
  params: Promise<{ caseId: string }>;
}

export async function GET(req: NextRequest, context: Context) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { caseId } = await context.params;
  const evidenceRequestId =
    req.nextUrl.searchParams.get("evidenceRequestId") ?? undefined;
  const access = await attachmentCaseAccess(
    caseId,
    { userId: auth.session.user.id, role: auth.session.user.role },
    evidenceRequestId,
  );
  if (!access)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const data = await prisma.supportCaseAttachment.findMany({
    where: {
      caseId,
      completedAt: { not: null },
      deletedAt: null,
      ...(evidenceRequestId
        ? { evidenceRequestId }
        : { evidenceRequestId: null }),
      ...(!access.staff
        ? { OR: [{ messageId: null }, { message: { isInternal: false } }] }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, originalName: true, fileSize: true, mimeType: true },
  });
  return NextResponse.json({
    data: data.map((file) => ({
      ...file,
      downloadUrl: `/api/support/attachments/${file.id}`,
    })),
  });
}

export async function POST(req: NextRequest, context: Context) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const limited = await applyRateLimit(
    documentUploadLimiter,
    `case-upload:${auth.session.user.id}`,
  );
  if (limited) return limited;
  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;
  const parsed = AttachmentUploadSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json(
      {
        error: "Choose a PDF, image, text or Word document up to 20 MB.",
        detail: parsed.error.flatten(),
      },
      { status: 400 },
    );
  const { caseId } = await context.params;
  const input = parsed.data;
  const actor = { userId: auth.session.user.id, role: auth.session.user.role };
  const access = await attachmentCaseAccess(
    caseId,
    actor,
    input.evidenceRequestId,
  );
  if (!access)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (
    access.supportCase.status === "CLOSED" ||
    access.request?.cancelledAt ||
    access.request?.respondedAt
  )
    return NextResponse.json(
      { error: "This evidence record is closed" },
      { status: 409 },
    );
  if (input.messageId) {
    const message = await prisma.supportCaseMessage.findFirst({
      where: {
        id: input.messageId,
        caseId,
        ...(!access.staff
          ? { isInternal: false, authorUserId: actor.userId }
          : {}),
      },
      select: { id: true },
    });
    if (!message)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const attachment = await prisma.$transaction(
      async (tx) => {
        const count = await tx.supportCaseAttachment.count({
          where: {
            caseId,
            uploadedById: actor.userId,
            deletedAt: null,
            OR: [
              { completedAt: { not: null } },
              { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
            ],
          },
        });
        if (count >= 20) return null;
        const fileId = crypto.randomUUID();
        return tx.supportCaseAttachment.create({
          data: {
            id: fileId,
            caseId,
            uploadedById: actor.userId,
            originalName: input.originalName,
            mimeType: input.mimeType,
            fileSize: input.fileSize,
            storagePath: `support-cases/${caseId}/${fileId}`,
            messageId: input.messageId,
            evidenceRequestId: input.evidenceRequestId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (!attachment)
      return NextResponse.json(
        { error: "Maximum 20 evidence files per person per case" },
        { status: 400 },
      );
    const { data, error } = await adminStorage()
      .from(SUPPORT_EVIDENCE_BUCKET)
      .createSignedUploadUrl(attachment.storagePath, { upsert: false });
    if (error || !data) {
      await prisma.supportCaseAttachment.updateMany({
        where: { id: attachment.id, completedAt: null },
        data: { deletedAt: new Date() },
      });
      return NextResponse.json(
        { error: "Upload unavailable; retry shortly" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        data: {
          id: attachment.id,
          uploadUrl: data.signedUrl,
          token: data.token,
          path: data.path,
        },
      },
      { status: 201 },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.case.attachments" },
    });
  }
}

export async function PUT(req: NextRequest, context: Context) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const parsed = z
    .object({ attachmentId: z.string().min(1).max(64) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid evidence" }, { status: 400 });
  const { caseId } = await context.params;
  const attachment = await prisma.supportCaseAttachment.findFirst({
    where: {
      id: parsed.data.attachmentId,
      caseId,
      uploadedById: auth.session.user.id,
      deletedAt: null,
    },
  });
  if (
    !attachment ||
    !(await attachmentCaseAccess(
      caseId,
      { userId: auth.session.user.id, role: auth.session.user.role },
      attachment.evidenceRequestId ?? undefined,
    ))
  )
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (attachment.completedAt)
    return NextResponse.json({ data: { id: attachment.id } });
  if (attachment.evidenceRequestId) {
    const request = await prisma.supportCaseEvidenceRequest.findUnique({
      where: { id: attachment.evidenceRequestId },
      select: { respondedAt: true, cancelledAt: true },
    });
    if (!request || request.respondedAt || request.cancelledAt)
      return NextResponse.json(
        { error: "This evidence response is already final" },
        { status: 409 },
      );
  }
  const info = await adminStorage()
    .from(SUPPORT_EVIDENCE_BUCKET)
    .info(attachment.storagePath);
  if (info.error || !info.data)
    return NextResponse.json(
      { error: "Finish uploading the file before confirming it" },
      { status: 409 },
    );
  if (
    info.data.size !== attachment.fileSize ||
    info.data.contentType !== attachment.mimeType
  )
    return NextResponse.json(
      { error: "The uploaded file does not match its declared type and size" },
      { status: 400 },
    );
  const completed = await prisma.$transaction(async (tx) => {
    const supportCase = await tx.supportCase.findUnique({
      where: { id: caseId },
      select: { updatedAt: true, closedAt: true },
    });
    if (!supportCase || supportCase.closedAt) return null;
    const locked = await tx.supportCase.updateMany({
      where: { id: caseId, updatedAt: supportCase.updatedAt, closedAt: null },
      data: { updatedAt: new Date() },
    });
    if (!locked.count) return null;
    if (attachment.evidenceRequestId) {
      const request = await tx.supportCaseEvidenceRequest.findUnique({
        where: { id: attachment.evidenceRequestId },
        select: { respondedAt: true, cancelledAt: true },
      });
      if (!request || request.respondedAt || request.cancelledAt) return null;
    }
    return tx.supportCaseAttachment.updateMany({
      where: { id: attachment.id, completedAt: null, deletedAt: null },
      data: { completedAt: new Date() },
    });
  });
  if (!completed)
    return NextResponse.json(
      {
        error:
          "The case or evidence request changed. Refresh before confirming the file.",
      },
      { status: 409 },
    );
  return NextResponse.json({
    data: { id: attachment.id, completed: completed.count > 0 },
  });
}
