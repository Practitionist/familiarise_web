/**
 * #1527 — one URL segment per support case. Pure: pages, routes, links and
 * jest read the same functions.
 *
 *   t_<ticketId>       a SupportTicket (platform, or escalated with its thread)
 *   s_<threadId>       a not-yet-escalated conversation (back office)
 *   b_<appointmentId>  the viewer's own conversation on a booking (user side)
 *
 * The user side keys a conversation by its booking: a thread is unique per
 * (appointment, user) and is only created by the first turn, so "Get help"
 * needs a URL before the row exists — and an unanswered click must not file
 * an empty conversation into the ops queue.
 */

export type CaseKind = "ticket" | "thread" | "booking";

export interface CaseRef {
  kind: CaseKind;
  id: string;
}

const PREFIX: Record<CaseKind, string> = {
  ticket: "t",
  thread: "s",
  booking: "b",
};

const KIND_BY_PREFIX: Record<string, CaseKind> = {
  t: "ticket",
  s: "thread",
  b: "booking",
};

// Ids are opaque (uuid in prod, readable slugs in seeds), so only the shape
// the go resolver will splice into a URL is accepted, length-bounded.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function caseKeyOf(ref: CaseRef): string {
  return `${PREFIX[ref.kind]}_${ref.id}`;
}

export function parseCaseKey(key: string | null | undefined): CaseRef | null {
  const match = /^([tsb])_(.+)$/.exec(key ?? "");
  if (!match || !ID_RE.test(match[2])) return null;
  return { kind: KIND_BY_PREFIX[match[1]], id: match[2] };
}
