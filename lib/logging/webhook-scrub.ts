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

const SENSITIVE_KEYS = new Set([
  "email",
  "phone",
  "mobile",
  "to",
  "from",
  "reply_to",
  "customer_email",
  "customer_phone",
  "contact",
  "vpa",
  "ip",
  "user_agent",
  "address",
  "billing_address",
  "shipping_address",
  "name",
  "customer_name",
  "first_name",
  "last_name",
  "card",
  "card_number",
  "cvv",
  "password",
  "token",
  "auth",
  "authorization",
  "signature",
]);

const SENSITIVE_SUFFIXES = [
  "_email",
  "_phone",
  "_mobile",
  "_contact",
  "_name",
  "_address",
  "_ip",
  "_vpa",
];

const MAX_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function redactFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === null || item === undefined ? item : "[redacted]",
    );
  }
  return value === null || value === undefined ? value : "[redacted]";
}

function redactScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (EMAIL_RX.test(value)) return "[redacted:email]";
  if (PHONE_RX.test(value.trim())) return "[redacted:phone]";
  return value;
}

function scrubObject(value: object, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveKey(key)
      ? redactFieldValue(entry)
      : scrub(entry, depth + 1);
  }
  return out;
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[redacted:too-deep]";
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1));
  }

  if (typeof value === "object") {
    return scrubObject(value, depth);
  }

  return redactScalar(value);
}

/**
 * Returns a deep-cloned, PII-scrubbed copy of the payload suitable for logging.
 */
export function scrubWebhookPayload(payload: unknown): unknown {
  return scrub(payload, 0);
}
