// One attendee's add-to-calendar links: a Google template URL and a signed .ics link whose
// HMAC binds appointment, user and purpose; the route re-checks the paid seat on every read.

import { getAppUrl } from "@/lib/url";
import { canSignLinks, safeEquals, signToken } from "@/lib/waitlist/tokens";
import { sessionEnd, stamp } from "./ics";

const PURPOSE = "calendar-ics";

export interface CalendarLinks {
  googleUrl: string;
  icsUrl: string;
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
