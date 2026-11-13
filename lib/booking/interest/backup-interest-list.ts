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
