/**
 * Razorpay checkout prefill helpers.
 *
 * Razorpay's Standard Checkout accepts `prefill.contact` as an
 * E.164-ish phone string. When the field is missing or malformed,
 * Razorpay's UI silently rejects the user's input on submit (test
 * mode also rejects repeated-digit numbers like 9999999999). Pass
 * the user's stored phone here so they don't have to retype it,
 * and validate before opening so we surface our own error instead
 * of letting Razorpay's modal fail opaquely.
 *
 * Reference issue: #717.
 */

const E164_RE = /^\+?[1-9]\d{9,14}$/;

/**
 * Normalize a stored phone string to a Razorpay-acceptable contact.
 * Strips spaces, hyphens, and parentheses; preserves the leading `+`
 * if present. Returns `null` when the string fails E.164 validation.
 */
export function normalizeRazorpayContact(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-()]/g, "");
  if (!E164_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Build a Razorpay `prefill` object from session-shaped user data.
 * Omits keys whose source value is empty so we don't blank out
 * Razorpay's own field guesses.
 */
export function buildRazorpayPrefill(user: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): { name?: string; email?: string; contact?: string } {
  const prefill: { name?: string; email?: string; contact?: string } = {};
  if (user.name) prefill.name = user.name;
  if (user.email) prefill.email = user.email;
  const contact = normalizeRazorpayContact(user.phone);
  if (contact) prefill.contact = contact;
  return prefill;
}
