import { DISPOSABLE_EMAIL_DOMAINS } from "./disposable-domains";

const GMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
]);

/** The mailbox an address delivers to: lowercased, `+tag` dropped, and Gmail dots ignored. */
export function normaliseEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  const domain = lower.slice(at + 1);
  const local = lower.slice(0, at).split("+")[0] || lower.slice(0, at);
  return GMAIL_DOMAINS.has(domain)
    ? `${local.replaceAll(".", "")}@gmail.com`
    : `${local}@${domain}`;
}

/** True when the address is on a known disposable-mailbox domain or one of its subdomains. */
export function isDisposableEmail(email: string): boolean {
  const lower = email.trim().toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  if (!domain) return false;
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
