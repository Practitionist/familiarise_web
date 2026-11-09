/** c_ identifies a support case; b_ opens contextual appointment help. */
export type CaseKind = "booking" | "case";
export interface CaseRef {
  kind: CaseKind;
  id: string;
}
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export function caseKeyOf(ref: CaseRef): string {
  return `${ref.kind === "case" ? "c" : "b"}_${ref.id}`;
}
export function parseCaseKey(key: string | null | undefined): CaseRef | null {
  const match = /^([bc])_(.+)$/.exec(key ?? "");
  if (!match || !ID_RE.test(match[2])) return null;
  return { kind: match[1] === "c" ? "case" : "booking", id: match[2] };
}

/** The role-agnostic page that opens contextual help for one appointment. */
export function bookingSupportPath(appointmentId: string): string {
  return `/dashboard/support/${caseKeyOf({ kind: "booking", id: appointmentId })}`;
}
