import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { fileApiError } from "@/lib/documents/api-error";

const RemovalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("remove"),
    reason: z.enum(["USER_REQUEST", "SUPPORT_ACTION"]),
  }),
  z.object({ action: z.literal("decline") }),
]);

/**
 * Support removes a whole document thread (reason recorded; the purge deletes
 * the objects after the grace window) or declines a learner's removal request.
 */
export async function POST(
  req: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  const auth = await requireBackofficeSurface("appointments.manage");
  if (auth.error) return auth.error;
  const { appointmentId, documentId } = await params;
  const parsed = RemovalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fileApiError("INVALID_INPUT");

  const root = await prisma.appointmentDocument.findFirst({
    where: { id: documentId, appointmentId, deletedAt: null },
    select: { id: true, rootDocumentId: true },
  });
  if (!root) return fileApiError("NOT_FOUND");
  const rootId = root.rootDocumentId ?? root.id;

  if (parsed.data.action === "decline") {
    const declined = await prisma.appointmentDocument.updateMany({
      where: { id: rootId, deletedAt: null, removalRequestedAt: { not: null } },
      data: { removalRequestedAt: null },
    });
    if (declined.count === 0) return fileApiError("REMOVAL_NOT_REQUESTED");
    return NextResponse.json({ declined: true });
  }

  const removed = await prisma.appointmentDocument.updateMany({
    where: {
      appointmentId,
      deletedAt: null,
      OR: [{ id: rootId }, { rootDocumentId: rootId }],
    },
    data: {
      deletedAt: new Date(),
      deletedById: auth.session.user.id,
      removalReason: parsed.data.reason,
    },
  });
  if (removed.count === 0) return fileApiError("GONE");
  return NextResponse.json({ removed: removed.count });
}
