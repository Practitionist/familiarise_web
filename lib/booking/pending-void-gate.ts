/**
 * The class remedy doors' one read of the pending-void gate: on the caller's
 * transaction or lock, the series' (or one source session's) unconfirmed
 * negative void, as the sentence the person reads in their zone.
 */
import type { Tx } from "@/lib/prisma";
import {
  DEFAULT_NOTIFICATION_TIMEZONE,
  resolveRecipientTimezones,
} from "@/lib/novu/humanize";
import { UNCONFIRMED_NEGATIVE_VOID } from "./misses";
import {
  pendingVerdictMessage,
  pendingVoidVerdict,
  type PendingVoidAction,
} from "./pending-void-verdict";

/**
 * Null when the remedy may run; otherwise the sentence that names the pending
 * session and its window's close. `occurrenceId` narrows it to one source session.
 */
export async function pendingVoidRefusal(
  db: Pick<Tx, "appointmentOccurrence" | "user">,
  args: {
    appointmentId: string;
    occurrenceId?: string;
    readerUserId: string;
    action: PendingVoidAction;
    now?: Date;
  },
): Promise<string | null> {
  const wait = pendingVoidVerdict(
    await db.appointmentOccurrence.findMany({
      where: {
        appointmentId: args.appointmentId,
        ...(args.occurrenceId ? { id: args.occurrenceId } : {}),
        isTentative: false,
        ...UNCONFIRMED_NEGATIVE_VOID,
      },
      select: {
        startsAt: true,
        completionStatus: true,
        deletedAt: true,
        seatsSettledAt: true,
        outcome: true,
        outcomeAt: true,
        outcomeConfirmedAt: true,
      },
    }),
  );
  if (!wait) return null;
  const zones = await resolveRecipientTimezones([args.readerUserId], db);
  return pendingVerdictMessage(
    wait,
    zones.get(args.readerUserId) ?? DEFAULT_NOTIFICATION_TIMEZONE,
    args.now ?? new Date(),
    args.action,
  );
}
