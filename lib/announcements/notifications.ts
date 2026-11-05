import type { Announcement } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { deriveTransactionId, stageTrigger } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

type BellAnnouncement = Pick<
  Announcement,
  | "id"
  | "title"
  | "content"
  | "isActive"
  | "startDate"
  | "endDate"
  | "linkUrl"
  | "linkText"
  | "updatedAt"
>;
type AnnouncementTx = Pick<Tx, "notificationOutbox">;

function bellWhere(id: string) {
  return {
    workflowId: NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
    entityRef: `announcement:${id}`,
  };
}

export function cancelAnnouncementBells(tx: AnnouncementTx, id: string) {
  return tx.notificationOutbox.updateMany({
    where: { ...bellWhere(id), status: { in: ["PENDING", "RETRY"] } },
    data: { status: "DEAD_LETTER", lastError: "announcement:cancelled" },
  });
}

/** An unsent publication follows edits; a recorded send is never broadcast again. */
export async function stageAnnouncementBell(
  tx: AnnouncementTx,
  announcement: BellAnnouncement,
  previous?: Pick<Announcement, "isActive" | "startDate" | "endDate">,
) {
  const now = new Date();
  if (
    !announcement.isActive ||
    (announcement.endDate && announcement.endDate <= now)
  ) {
    await cancelAnnouncementBells(tx, announcement.id);
    return null;
  }
  if (previous) {
    const sent = await tx.notificationOutbox.findFirst({
      where: { ...bellWhere(announcement.id), status: "SENT" },
      select: { id: true },
    });
    const wasLive =
      previous.isActive &&
      (!previous.startDate || previous.startDate <= now) &&
      (!previous.endDate || previous.endDate > now);
    const isScheduled = announcement.startDate && announcement.startDate > now;
    const pending =
      wasLive && !isScheduled
        ? await tx.notificationOutbox.findFirst({
            where: {
              ...bellWhere(announcement.id),
              status: { in: ["PENDING", "RETRY"] },
            },
            select: { id: true },
          })
        : true;
    if (sent || !pending) {
      await cancelAnnouncementBells(tx, announcement.id);
      return null;
    }
  }
  const payload = {
    announcementId: announcement.id,
    revision: announcement.updatedAt.toISOString(),
    startDate: announcement.startDate?.toISOString() ?? null,
    endDate: announcement.endDate?.toISOString() ?? null,
    title: announcement.title,
    content: announcement.content,
    ...(announcement.linkUrl ? { linkUrl: announcement.linkUrl } : {}),
    ...(announcement.linkText ? { linkText: announcement.linkText } : {}),
  };
  const transactionId = deriveTransactionId(
    NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
    [],
    payload,
  );
  await tx.notificationOutbox.updateMany({
    where: {
      ...bellWhere(announcement.id),
      transactionId: { not: transactionId },
      status: { in: ["PENDING", "RETRY"] },
    },
    data: { status: "DEAD_LETTER", lastError: "announcement:superseded" },
  });
  return stageTrigger({
    tx,
    workflowId: NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
    kind: "BROADCAST",
    recipients: [],
    payload,
    entityRef: `announcement:${announcement.id}`,
    ...(announcement.startDate && announcement.startDate > now
      ? { notBefore: announcement.startDate }
      : {}),
  });
}
