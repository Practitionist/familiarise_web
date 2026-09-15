import { createHash } from "node:crypto";

// #1298 — Resend dedupes on Idempotency-Key for 24 h, which covers the whole
// retry ladder, so a replay of a send whose response was lost is not a second
// email. Derived from content, not stored: a re-requested link has a new token
// in the html and therefore a new key. Well under Resend's 256-char cap.
export function idempotencyKeyFor(
  message: { to: string; subject: string; html: string },
  emailType: string,
): string {
  const digest = createHash("sha256")
    .update(`${message.to}\n${message.subject}\n${message.html}`)
    .digest("hex");
  return `${emailType}/${digest.slice(0, 48)}`;
}
