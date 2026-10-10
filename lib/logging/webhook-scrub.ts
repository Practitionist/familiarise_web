/**
 * Webhook payload PII scrubber.
 *
 * Payment-gateway webhooks (Razorpay, Stripe) often include payer contact
 * info (email, phone), partial card/UPI identifiers, billing addresses,
 * and arbitrary `notes`/`metadata` bags that app-level code may populate
 * with user-ids or email addresses.
 *
 * We want our server-side logs to be debuggable (event types, amounts,
 * provider ids) but not a retention liability under DPDP / GDPR. This
 * module provides a single `scrubWebhookPayload` entry point used by both
 * webhook routes when they log the payload before async processing.
 *
 * Rules:
 *  - Redact any key that looks like contact info (email, phone, *_email,
 *    *_phone, contact, vpa, card.last4, card.name).
 *  - Redact any value that matches an email or phone regex, regardless
 *    of key name (guards against nested `notes: { referrerEmail: ... }`).
 *  - Preserve ids, status strings, amounts, currencies, timestamps.
 *  - Preserve short prefixes like `pay_`, `order_`, `rfnd_`, `po_`,
 *    `evt_` so correlation IDs remain grep-able in Cloud logs.
 *  - Depth-limit recursion to avoid stack blow-ups on malicious payloads.
 */

const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RX = /^\+?\d[\d\s\-()]{7,}$/;

const SENSITIVE_KEY_RX =
  /^(email|phone|mobile|to|from|reply_to|customer_email|customer_phone|contact|vpa|ip|user_agent|address|billing_address|shipping_address|name|customer_name|first_name|last_name|card|card_number|cvv|password|token|auth|authorization|signature)$/i;

const SENSITIVE_SUFFIX_RX =
  /_(email|phone|mobile|contact|name|address|ip|vpa)$/i;

const MAX_DEPTH = 6;

function redactScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (EMAIL_RX.test(value)) return "[redacted:email]";
  if (PHONE_RX.test(value.trim())) return "[redacted:phone]";
  return value;
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[redacted:too-deep]";
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RX.test(key) || SENSITIVE_SUFFIX_RX.test(key)) {
        if (Array.isArray(v)) {
          out[key] = v.map((item) =>
            item === null || item === undefined ? item : "[redacted]",
          );
        } else {
          out[key] = v === null || v === undefined ? v : "[redacted]";
        }
        continue;
      }
      out[key] = scrub(v, depth + 1);
    }
    return out;
  }

  return redactScalar(value);
}

/**
 * Returns a deep-cloned, PII-scrubbed copy of the payload suitable for logging.
 */
export function scrubWebhookPayload(payload: unknown): unknown {
  return scrub(payload, 0);
}
