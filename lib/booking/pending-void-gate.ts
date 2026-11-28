/**
 * The remedy doors' one read of the pending-void gate: on the caller's
 * transaction or lock, the booking's (or one source session's) unconfirmed
 * negative void, as the sentence the person reads in their zone.
 */
import type { Tx } from "@/lib/prisma";
import { isPriceFreePayment } from "@/lib/payments/funding-rail";
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

type SeatMoney = {
  paymentIntent: string;
  amount: bigint | number;
  originalAmount: bigint | number | null;
};

/** A seat's payment carries money unless it is price-free; a credit- or wallet-funded seat carries money. */
export function seatCarriesMoney(payment: SeatMoney | null): boolean {
  return (
    !!payment &&
    !isPriceFreePayment({
      paymentIntent: payment.paymentIntent,
      amountPaise: Number(payment.amount),
      listPricePaise: Number(payment.originalAmount ?? 0),
    })
  );
}

/** Whether any seat of the booking carries money, so a whole-class cancel would move refunds. */
export async function anySeatCarriesMoney(
  db: Pick<Tx, "payment">,
  appointmentId: string,
): Promise<boolean> {
  const payments = await db.payment.findMany({
    where: { appointmentId, paymentStatus: "SUCCEEDED", deletedAt: null },
    select: { paymentIntent: true, amount: true, originalAmount: true },
  });
  return payments.some(seatCarriesMoney);
}

/** Which whole-booking cancel is waiting, for its sentence: a class's, a plan's or a consultation's. */
export function pendingVoidCancelAction(booking: {
  class: unknown;
  subscription: unknown;
}): PendingVoidAction {
  if (booking.class) return "cancel";
  return booking.subscription ? "cancelPlan" : "cancelBooking";
}

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
