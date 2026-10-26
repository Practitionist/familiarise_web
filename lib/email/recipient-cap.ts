import { createHash } from "node:crypto";
import { makeLimiter } from "@/lib/rate-limit";
import { captureThrottled } from "@/lib/observability/throttled-capture";

/** Mail a stranger can aim at any address by typing it into a public auth form. */
export const RECIPIENT_CAPPED_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "EXISTING_ACCOUNT_SIGN_UP",
]);

/** Per address, per email type, per rolling 24 hours. */
export const RECIPIENT_DAILY_CAP = 5;

// Built on first capped send, so importing the send core never touches Redis.
let recipientLimiter: ReturnType<typeof makeLimiter> | null = null;

export class EmailRecipientCappedError extends Error {
  constructor() {
    super("Recipient reached the daily cap for this email type");
    this.name = "EmailRecipientCappedError";
  }
}

/**
 * True when this send would exceed the recipient's daily cap. The key holds
 * a SHA-256 of the address, never the address. Fails open on a Redis error.
 */
export async function overRecipientCap(
  to: string,
  emailType: string,
): Promise<boolean> {
  if (!RECIPIENT_CAPPED_EMAIL_TYPES.has(emailType)) return false;
  const digest = createHash("sha256")
    .update(to.trim().toLowerCase())
    .digest("hex");
  try {
    recipientLimiter ??= makeLimiter(
      RECIPIENT_DAILY_CAP,
      "24 h",
      "rl:mail-recipient",
    );
    const { success } = await recipientLimiter.limit(`${emailType}:${digest}`);
    return !success;
  } catch (error) {
    captureThrottled("email:recipient-cap", error, {
      subsystem: "email",
      op: "recipient-cap",
      level: "warning",
    });
    return false;
  }
}
