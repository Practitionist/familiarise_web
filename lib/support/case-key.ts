/** Canonical c_ URLs identify a SupportCase. Legacy t_/s_ URLs resolve through aliases.
 * Booking b_ URLs can begin a conversation before its first turn creates a case. */

export type CaseKind = "ticket" | "thread" | "booking" | "case";

export interface CaseRef {
  kind: CaseKind;
  id: string;
}

const PREFIX: Record<CaseKind, string> = {
  ticket: "t",
  thread: "s",
  booking: "b",
  case: "c",
};

const KIND_BY_PREFIX: Record<string, CaseKind> = {
  t: "ticket",
  s: "thread",
  b: "booking",
  c: "case",
};

// Ids are opaque (uuid in prod, readable slugs in seeds), so only the shape
// the go resolver will splice into a URL is accepted, length-bounded.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function caseKeyOf(ref: CaseRef): string {
  return `${PREFIX[ref.kind]}_${ref.id}`;
}

export function parseCaseKey(key: string | null | undefined): CaseRef | null {
  const match = /^([tsbc])_(.+)$/.exec(key ?? "");
  if (!match || !ID_RE.test(match[2])) return null;
  return { kind: KIND_BY_PREFIX[match[1]], id: match[2] };
}
