import {
  BackupInterestListResponseSchema,
  type BackupInterestEntry,
} from "@/schemas/interest";

/** A learner may wait on at most this many 1:1 times at once. */
export const BACKUP_INTEREST_CAP = 3;

/** The learner's own open "Notify me" rows; an unreadable answer throws, so it never reads as none. */
export async function fetchBackupInterest(): Promise<BackupInterestEntry[]> {
  const res = await fetch("/api/scheduling/backup-interest");
  if (!res.ok) throw new Error("Could not read your waiting list");
  const parsed = BackupInterestListResponseSchema.safeParse(
    await res.json().catch(() => null),
  );
  if (!parsed.success) throw new Error("Could not read your waiting list");
  return parsed.data.data;
}

/**
 * Where "Book this time" leads: the expert's page with the plan's booking
 * dialog open on that time. The page's own read decides whether it is still
 * free and which availability row it comes from.
 */
export function backupBookHref(entry: {
  consultantProfileId: string;
  planKind?: string | null;
  planId?: string | null;
  windowStart: string;
  windowEnd: string;
}): string {
  const page = `/explore/experts/${entry.consultantProfileId}`;
  if (!entry.planId || entry.planKind !== "CONSULTATION") return page;
  const query = new URLSearchParams({
    action: "book",
    plan: entry.planId,
    startsAt: entry.windowStart,
    endsAt: entry.windowEnd,
  });
  return `${page}?${query.toString()}`;
}
