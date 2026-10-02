import { normaliseEmail } from "./suppression";

// Until launch, mail goes only to our own domain and EMAIL_ALLOWLIST: the
// shared database holds seeded users whose faker addresses are real inboxes.

/** The outbox `lastError` of a message the guard withheld; its row is DEAD_LETTER. */
export const HELD_PRE_LAUNCH = "held:pre-launch";

const OWN_DOMAIN = "familiarisenow.com";

/** Returned by `attempt()` in place of a send when the guard holds the message. */
export class EmailHeldError extends Error {
  constructor() {
    super(HELD_PRE_LAUNCH);
    this.name = "EmailHeldError";
  }
}

/** Every recipient of a Resend message, accepting both string and list fields. */
export function recipientsOf(message: Record<string, unknown>): string[] {
  return [message.to, message.cc, message.bcc].flatMap((field) => {
    if (typeof field === "string") return [field];
    if (Array.isArray(field)) {
      return field.filter((v): v is string => typeof v === "string");
    }
    return [];
  });
}

// `Name <a@b>` and bare `a@b` both reduce to the bare, lower-cased address.
function addressOf(raw: string): string {
  const bracketed = /<([^<>]+)>/.exec(raw);
  return normaliseEmail(bracketed ? bracketed[1] : raw);
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1);
}

function isAllowed(address: string, allowlist: string[]): boolean {
  const domain = domainOf(address);
  if (!domain) return false;
  if (domain === OWN_DOMAIN || domain.endsWith(`.${OWN_DOMAIN}`)) return true;
  return allowlist.some((entry) =>
    entry.startsWith("@") ? domain === entry.slice(1) : address === entry,
  );
}

/**
 * Null when the message may be sent; otherwise the domain of the first refused
 * recipient (never the address). Any mode other than `live` is `allowlist`.
 */
export function heldRecipientDomain(
  recipients: string | readonly string[],
): string | null {
  if (process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase() === "live") {
    return null;
  }
  const allowlist = (process.env.EMAIL_ALLOWLIST ?? "")
    .split(",")
    .map(normaliseEmail)
    .filter(Boolean);
  const list = typeof recipients === "string" ? [recipients] : recipients;
  if (list.length === 0) return null;
  for (const raw of list) {
    const address = addressOf(raw);
    if (!isAllowed(address, allowlist)) return domainOf(address) || "(none)";
  }
  return null;
}

export function logHeld(emailType: string, recipientDomain: string): void {
  console.info("[email] held pre-launch", {
    event: "email.held_pre_launch",
    emailType,
    recipientDomain,
  });
}
