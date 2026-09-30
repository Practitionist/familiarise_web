/**
 * #1861 S4 — a second, Sentry-side scrubbing pass over outgoing events and
 * breadcrumbs.
 *
 * lib/logging/webhook-scrub.ts scrubs webhook PAYLOADS (email/phone/name)
 * before they are logged; its key list does not cover secrets and tokens,
 * which is the leak this module closes for whatever Sentry captures on its
 * own (request headers, cookies, extra/context blobs, breadcrumb URLs) —
 * `authorization`, `cookie`, signature headers, and any key that looks like
 * a credential, bank identifier, or card number. It deliberately does NOT
 * touch WebhookEvent.payload / logWebhookEvent: the stuck-webhook sweeper
 * (scripts/cleanup/sweep-stuck-webhook-events.ts) replays from that stored
 * payload verbatim, and that scrubbing question belongs to #1530.
 */

import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

const MAX_DEPTH = 6;

const REDACTED = "[redacted]";

// Exact header names, matched case-insensitively, plus a substring match on
// "secret" / "token" for anything not enumerated (custom internal headers).
//
// #1829 — `x-signature` joins the enumerated set. It is Stream's webhook HMAC
// and the substring rule could not have caught it: the name contains neither
// "secret" nor "token", only "signature". Every `Sentry.captureException` on
// the Stream webhook path therefore shipped the live HMAC of a verified delivery
// in `event.request.headers` — while Razorpay's and Stripe's equivalents were
// redacted, so the list read as complete and nobody looked for a fourth.
const REDACT_HEADER_EXACT = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-razorpay-signature",
  "stripe-signature",
  "x-signature",
  "svix-signature",
  "svix-hmac-sha256",
  "x-maintenance-bypass",
  "x-cron-secret",
]);

function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    REDACT_HEADER_EXACT.has(lower) ||
    lower.includes("secret") ||
    lower.includes("token")
  );
}

function redactHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (shouldRedactHeader(key)) headers[key] = REDACTED;
  }
}

// Key-based redaction for nested data/extra/contexts blobs. Matches the key,
// not the value, so a differently-shaped payload is still caught.
const SENSITIVE_KEY_RX =
  /token|secret|password|passwd|authorization|account_?number|ifsc|vpa|card_?number|cvv/i;
// PAN only as a whole word (`pan`, `panNumber`, `pan_last4`, `PAN`) — a bare
// substring would also redact `companyName` and `participantId`.
const PAN_KEY_RX = /(?:^|[_-])(?:pan|PAN)(?:[A-Z_-]|$)/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RX.test(key) || PAN_KEY_RX.test(key);
}

/** Plain data objects only — never recurse into a Date, Map, Error, etc. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactByKey(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactByKey(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = v === null || v === undefined ? v : REDACTED;
    } else {
      out[key] = redactByKey(v, depth + 1);
    }
  }
  return out;
}

/**
 * Sentry-side event scrubber. Called from beforeSend AFTER the existing
 * expected-error relabel + infra throttle, never before — this only removes
 * data, it never changes routing/dropping decisions.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    redactHeaders(event.request.headers);
    // Cookies carry the session outright; there is nothing to redact
    // key-by-key, so the whole map is dropped.
    delete event.request.cookies;
    if (event.request.data !== undefined) {
      event.request.data = redactByKey(event.request.data, 0);
    }
    // Invite, reset and waitlist links carry their token in the query string.
    if (typeof event.request.url === "string") {
      event.request.url = stripSensitiveQueryParams(event.request.url);
    }
    if (event.request.query_string !== undefined) {
      event.request.query_string = redactQueryString(
        event.request.query_string,
      );
    }
  }
  if (event.extra) {
    event.extra = redactByKey(event.extra, 0) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = redactByKey(event.contexts, 0) as typeof event.contexts;
  }
  return event;
}

// `code` is the OAuth authorization code on the Better Auth callback URL.
const SENSITIVE_QUERY_PARAM_RX = /token|secret|signature|^code$/i;

type QueryString = NonNullable<
  NonNullable<ErrorEvent["request"]>["query_string"]
>;

/** Redacts sensitive params in any of Sentry's three query_string shapes. */
function redactQueryString(qs: QueryString): QueryString {
  if (typeof qs === "string") {
    const params = new URLSearchParams(qs);
    let changed = false;
    for (const key of Array.from(params.keys())) {
      if (SENSITIVE_QUERY_PARAM_RX.test(key)) {
        params.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? params.toString() : qs;
  }
  if (Array.isArray(qs)) {
    return qs.map(([key, value]) => [
      key,
      SENSITIVE_QUERY_PARAM_RX.test(key) ? REDACTED : value,
    ]) as QueryString;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(qs)) {
    out[key] = SENSITIVE_QUERY_PARAM_RX.test(key) ? REDACTED : value;
  }
  return out;
}

/** Strips sensitive query params from a URL string; returns it unchanged on parse failure. */
function stripSensitiveQueryParams(url: string): string {
  try {
    // Breadcrumb URLs are sometimes relative; a placeholder origin lets URL
    // parse them, and is stripped back off below.
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const parsed = new URL(
      url,
      isAbsolute ? undefined : "https://placeholder.invalid",
    );
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAM_RX.test(key)) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    if (!changed) return url;
    return isAbsolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/**
 * Sentry-side breadcrumb scrubber for http/fetch breadcrumbs — the same
 * header redaction as scrubSentryEvent, plus query-param stripping on the
 * recorded URL.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.category !== "http" && breadcrumb.category !== "fetch") {
    return breadcrumb;
  }
  const data = breadcrumb.data;
  if (!data) return breadcrumb;

  if (typeof data.url === "string") {
    data.url = stripSensitiveQueryParams(data.url);
  }
  redactHeaders(data.request_headers as Record<string, string> | undefined);
  redactHeaders(data.response_headers as Record<string, string> | undefined);

  return breadcrumb;
}
