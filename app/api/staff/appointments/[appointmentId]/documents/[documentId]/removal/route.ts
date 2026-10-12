import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
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

  const actor = {
    actorUserId: auth.session.user.id,
    actorRole: String(auth.session.user.role ?? "UNKNOWN"),
    surface: "appointments.manage" as const,
    targetKind: "AppointmentDocument",
    targetId: rootId,
  };

  if (parsed.data.action === "decline") {
    const declined = await prisma.$transaction(async (tx) => {
      const { count } = await tx.appointmentDocument.updateMany({
        where: {
          id: rootId,
          deletedAt: null,
          removalRequestedAt: { not: null },
        },
        data: { removalRequestedAt: null },
      });
      if (count > 0) {
        await recordOpsAction(tx, {
          ...actor,
          action: "document.removal.decline",
          reason: "Learner's removal request declined",
        });
      }
      return count;
    });
    if (declined === 0) return fileApiError("REMOVAL_NOT_REQUESTED");
    return NextResponse.json({ declined: true });
  }

  const reason = parsed.data.reason;
  const removed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.appointmentDocument.updateMany({
      where: {
        appointmentId,
        deletedAt: null,
        OR: [{ id: rootId }, { rootDocumentId: rootId }],
      },
      data: {
        deletedAt: new Date(),
        deletedById: actor.actorUserId,
        removalReason: reason,
      },
    });
    if (count > 0) {
      await recordOpsAction(tx, {
        ...actor,
        action: "document.removal.remove",
        reason,
        after: { removalReason: reason, versions: count },
      });
    }
    return count;
  });
  if (removed === 0) return fileApiError("GONE");
  return NextResponse.json({ removed });
}
