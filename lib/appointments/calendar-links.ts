// One attendee's add-to-calendar links: a Google template URL and a signed .ics link whose
// HMAC binds appointment, user and purpose; the route re-checks the paid, unrefunded seat on every read.

import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { isFullyRefundedPurchase } from "@/lib/payments/utils/refund-balance";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import { paidParticipant } from "@/lib/booking/participants";
import { getAppUrl } from "@/lib/url";
import { canSignLinks, safeEquals, signToken } from "@/lib/auth/link-signing";
import { sessionEnd, stamp } from "./ics";

const PURPOSE = "calendar-ics";

export interface CalendarLinks {
  googleUrl: string;
  icsUrl: string;
}

/** The attendee seat a calendar link stands for; the .ics route and the success page both require it. */
export function calendarSeatWhere(
  userId: string,
): Prisma.AppointmentParticipantWhereInput {
  return { ...paidParticipant(userId), role: "CONSULTEE" };
}

/**
 * The calendar entitlement the .ics route and the success page share: a paid
 * attendee seat whose own payment is not fully refunded (pending or done).
 */
export async function holdsCalendarSeat(
  db: Pick<Tx, "appointmentParticipant">,
  appointmentId: string,
  userId: string,
): Promise<boolean> {
  const seat = await db.appointmentParticipant.findFirst({
    where: { appointmentId, ...calendarSeatWhere(userId) },
    select: {
      payment: {
        select: {
          amount: true,
          paymentIntent: true,
          refunds: { select: { amountPaise: true, status: true } },
        },
      },
    },
  });
  if (!seat) return false;
  return !seat.payment || !isFullyRefundedPurchase([seat.payment]);
}

export interface CalendarSession {
  startsAt: Date;
  endsAt: Date | null;
}

/** The earliest live session still ahead of `now`: the one a single-event calendar link names. */
export function nextSessionAhead(
  sessions: ReadonlyArray<
    CalendarSession & {
      completionStatus?: string | null;
      deletedAt?: Date | string | null;
    }
  >,
  now: Date = new Date(),
): CalendarSession | null {
  const next = sessions
    .filter((s) => !isDeadOccurrence(s) && s.startsAt.getTime() > now.getTime())
    .reduce<CalendarSession | null>(
      (best, s) =>
        !best || s.startsAt.getTime() < best.startsAt.getTime() ? s : best,
      null,
    );
  return next ? { startsAt: next.startsAt, endsAt: next.endsAt } : null;
}

/** The booking's dashboard page; the go resolver lands each viewer on their own side. */
export function appointmentDashboardUrl(appointmentId: string): string {
  return `${getAppUrl()}/dashboard/go/auto/appointments/${encodeURIComponent(appointmentId)}`;
}

/** The one line a calendar entry carries beyond its title and times. */
export function calendarDetails(appointmentId: string): string {
  return `Join from your Familiarise dashboard: ${appointmentDashboardUrl(appointmentId)}`;
}

function calendarToken(appointmentId: string, userId: string): string {
  return signToken(PURPOSE, `${appointmentId}|${userId}`, 0);
}

export function verifyCalendarToken(
  appointmentId: string,
  userId: string,
  token: string,
): boolean {
  return safeEquals(token, () => calendarToken(appointmentId, userId));
}

/** Both links for `userId`, or null when links cannot be signed here. */
export function calendarLinks(args: {
  appointmentId: string;
  userId: string;
  title: string;
  startsAt: Date;
  endsAt?: Date | null;
}): CalendarLinks | null {
  if (!canSignLinks()) return null;
  const ics = new URLSearchParams({
    u: args.userId,
    t: calendarToken(args.appointmentId, args.userId),
  });
  const google = new URLSearchParams({
    action: "TEMPLATE",
    text: args.title,
    dates: `${stamp(args.startsAt)}/${stamp(sessionEnd(args.startsAt, args.endsAt ?? null))}`,
    details: calendarDetails(args.appointmentId),
  });
  return {
    googleUrl: `https://calendar.google.com/calendar/render?${google}`,
    icsUrl: `${getAppUrl()}/api/calendar/${encodeURIComponent(args.appointmentId)}?${ics}`,
  };
}
