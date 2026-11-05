import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { announcementBellContextSchema } from "@/schemas/announcements";

/** A queued revision cannot publish after its source is changed, disabled, expired or deleted. */
export async function announcementDeliveryDecision(
  payload: Prisma.JsonValue,
  now: Date,
  db: Pick<Tx, "announcement">,
): Promise<{ skip: string } | { notBefore: Date } | null> {
  const parsed = announcementBellContextSchema.safeParse(payload);
  if (!parsed.success) return { skip: "announcement:invalid_context" };
  const current = await db.announcement.findUnique({
    where: { id: parsed.data.announcementId },
  });
  if (!current) return { skip: "announcement:deleted" };
  if (!current.isActive) return { skip: "announcement:inactive" };
  if (current.endDate && current.endDate <= now)
    return { skip: "announcement:expired" };
  if (
    current.updatedAt.toISOString() !== parsed.data.revision ||
    current.title !== parsed.data.title ||
    current.content !== parsed.data.content ||
    (current.linkUrl || undefined) !== parsed.data.linkUrl ||
    (current.linkText || undefined) !== parsed.data.linkText ||
    (current.startDate?.toISOString() ?? null) !== parsed.data.startDate ||
    (current.endDate?.toISOString() ?? null) !== parsed.data.endDate
  )
    return { skip: "announcement:superseded" };
  return current.startDate && current.startDate > now
    ? { notBefore: current.startDate }
    : null;
}
