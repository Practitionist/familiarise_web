/**
 * #1527 — "Add to calendar" for a booking, built in the browser from the
 * occurrences the detail page already holds: no new API. Times are written
 * in UTC (`Z`), which every calendar converts to the reader's own zone, and
 * the viewer's zone rides along as `X-WR-TIMEZONE` for clients that label it.
 */

export interface IcsSession {
  id: string;
  startsAt: Date;
  endsAt: Date | null;
}

export interface IcsInput {
  title: string;
  description?: string;
  /** Absolute URL of the booking, so the event links back to it. */
  url?: string;
  sessions: IcsSession[];
  /** IANA zone of the viewer, e.g. "Asia/Kolkata". */
  zone: string;
  now?: Date;
}

/** A session without an end is booked for this long. */
const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

function stamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** RFC 5545 §3.3.11 text escaping. */
function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", String.raw`\;`)
    .replaceAll(",", String.raw`\,`)
    .replaceAll(/\r?\n/g, String.raw`\n`);
}

export function buildIcs({
  title,
  description,
  url,
  sessions,
  zone,
  now = new Date(),
}: IcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Familiarise//Appointments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-TIMEZONE:${zone}`,
  ];
  for (const session of sessions) {
    const end =
      session.endsAt ??
      new Date(session.startsAt.getTime() + DEFAULT_LENGTH_MS);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.id}@familiarise`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(session.startsAt)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${escapeText(title)}`,
      ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
      ...(url ? [`URL:${url}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 lines end in CRLF.
  return `${lines.join("\r\n")}\r\n`;
}
