import { createHash } from "node:crypto";

// #1298 — Resend dedupes on Idempotency-Key for 24 h, which covers the whole
// retry ladder, so a replay of a send whose response was lost is not a second
// email. When a FailedEmail row ID is supplied, derive the key directly from
// the row ID without hashing the HTML body; otherwise derive from content so
// a re-requested link with a new token gets a distinct key.
export function idempotencyKeyFor(
  message: { to: string; subject: string; html: string },
  emailType: string,
  rowId?: string,
): string {
  if (rowId) {
    return `${emailType}/failed-email/${rowId}`;
  }
  const digest = createHash("sha256")
    .update(`${message.to}\n${message.subject}\n${message.html}`)
    .digest("hex");
  return `${emailType}/${digest.slice(0, 48)}`;
}
