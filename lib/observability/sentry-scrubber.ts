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

import type * as Sentry from "@sentry/nextjs";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { isProductionEnvironment } from "@/utils/env";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
export type ScrubberSpan = Parameters<
  NonNullable<SentryInitOptions["beforeSendSpan"]>
>[0];
export type ScrubberLog = Parameters<
  NonNullable<SentryInitOptions["beforeSendLog"]>
>[0];

const MAX_DEPTH = 6;

const REDACTED = "[redacted]";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";

const EMAIL_VALUE_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_VALUE_RX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const INLINE_QUERY_SECRET_RX =
  /([?&](?:token|secret|signature|code)=)[^&\s#]+/gi;

/**
 * Scrubs free-form string values (log messages, span descriptions, exception
 * messages, nested string fields) for email addresses, Bearer tokens, and
 * sensitive URL query parameters.
 */
export function scrubStringValue(value: string): string {
  return value
    .replace(EMAIL_VALUE_RX, REDACTED_EMAIL)
    .replace(BEARER_VALUE_RX, "Bearer [REDACTED]")
    .replace(INLINE_QUERY_SECRET_RX, `$1${REDACTED}`);
}

// Exact header names, matched case-insensitively, plus a substring match on
// "secret" / "token" for anything not enumerated (custom internal headers).
const REDACT_HEADER_EXACT = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-razorpay-signature",
  "stripe-signature",
  "x-maintenance-bypass",
  "x-cron-secret",
  "x-api-key",
]);

function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    REDACT_HEADER_EXACT.has(lower) ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("signature") ||
    lower.includes("apikey") ||
    lower.includes("api-key")
  );
}

function redactHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (shouldRedactHeader(key)) {
      headers[key] = REDACTED;
    } else if (typeof headers[key] === "string") {
      headers[key] = scrubStringValue(headers[key]);
    }
  }
}

// Key-based redaction for nested data/extra/contexts/attributes blobs. Matches
// the key, not the value, so a differently-shaped payload is still caught.
const SENSITIVE_KEY_RX =
  /token|secret|password|passwd|authorization|cookie|set-cookie|signature|api_?key|private_?key|client_?secret|access_?key|session_?id|account_?number|ifsc|vpa|upi|iban|routing_?number|bank_?account|card_?number|cvv|cvc|aadhaar|ssn|gstin|tax_?id|raw_?value/i;
// Container keys that SDK errors (e.g. NovuError.body) populate with raw HTTP
// bodies/payloads: redact when primitive/string, recurse when a plain object.
const BODY_CONTAINER_KEY_RX =
  /^(?:body|raw_?body|response_?body|request_?body|payload)$/i;
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

/**
 * Sanitizes Error instances (such as NovuError in `extra.thrown`) whose own
 * enumerable properties (`body`, `rawValue`, `response`) can carry echoed PII.
 */
function scrubErrorInstance(err: Error, depth: number): Error {
  const scrubbedMsg = scrubStringValue(err.message);
  const ownKeys = Object.keys(err);
  if (ownKeys.length === 0 && scrubbedMsg === err.message) {
    return err;
  }
  const clone = new Error(scrubbedMsg);
  clone.name = err.name;
  if (typeof err.stack === "string") {
    clone.stack = scrubStringValue(err.stack);
  }
  const target = clone as unknown as Record<string, unknown>;
  const source = err as unknown as Record<string, unknown>;
  for (const key of ownKeys) {
    if (key === "message" || key === "name" || key === "stack") continue;
    const v = source[key];
    if (isSensitiveKey(key) || BODY_CONTAINER_KEY_RX.test(key)) {
      target[key] = v === null || v === undefined ? v : REDACTED;
    } else {
      target[key] = redactByKey(v, depth + 1);
    }
  }
  return clone;
}

function redactByKey(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    return scrubStringValue(value);
  }
  if (value instanceof Error) {
    return scrubErrorInstance(value, depth);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactByKey(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = v === null || v === undefined ? v : REDACTED;
    } else if (BODY_CONTAINER_KEY_RX.test(key)) {
      if (isPlainObject(v) || Array.isArray(v)) {
        out[key] = redactByKey(v, depth + 1);
      } else {
        out[key] = v === null || v === undefined ? v : REDACTED;
      }
    } else {
      out[key] = redactByKey(v, depth + 1);
    }
  }
  return out;
}

/**
 * Sentry-side event scrubber. Called from beforeSend and beforeSendTransaction
 * AFTER the existing expected-error relabel + infra throttle, never before —
 * this only removes data, it never changes routing/dropping decisions.
 */
export function scrubSentryEvent<T extends Sentry.Event = ErrorEvent>(
  event: T,
): T {
  if (typeof event.message === "string") {
    event.message = scrubStringValue(event.message);
  }
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") {
        ex.value = scrubStringValue(ex.value);
      }
    }
  }
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
 * Sentry-side breadcrumb scrubber. Scrubs free-form message strings across all
 * categories and applies URL query-param + header redaction to http/fetch
 * breadcrumbs.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = scrubStringValue(breadcrumb.message);
  }
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

function scrubSpanMap(map: Record<string, unknown>): Record<string, unknown> {
  const prefiltered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === "culture.timezone") continue;
    if ((k === "http.query" || k === "url.query") && typeof v === "string") {
      prefiltered[k] = redactQueryString(v);
    } else {
      prefiltered[k] = v;
    }
  }
  return redactByKey(prefiltered, 0) as Record<string, unknown>;
}

/**
 * Sentry-side span scrubber (`beforeSendSpan`, #1916 / #1926).
 *
 * Strips ungated `culture.timezone` attributes/contexts that `dataCollection`
 * does not gate on spans, and scrubs span descriptions and data attributes for
 * PII, tokens, and sensitive query parameters.
 */
export function scrubSentrySpan<
  T extends ScrubberSpan & {
    name?: string;
    attributes?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
  },
>(span: T): T {
  if (typeof span.description === "string") {
    span.description = stripSensitiveQueryParams(
      scrubStringValue(span.description),
    );
  }
  if (typeof span.name === "string") {
    span.name = stripSensitiveQueryParams(scrubStringValue(span.name));
  }
  if (span.data && typeof span.data === "object") {
    span.data = scrubSpanMap(span.data) as typeof span.data;
  }
  if (span.attributes && typeof span.attributes === "object") {
    span.attributes = scrubSpanMap(span.attributes);
  }
  const culture = span.contexts?.culture as Record<string, unknown> | undefined;
  if (culture && "timezone" in culture) {
    span.contexts = {
      ...span.contexts,
      culture: Object.fromEntries(
        Object.entries(culture).filter(([k]) => k !== "timezone"),
      ),
    };
  }
  return span;
}

/**
 * Sentry-side structured log scrubber (`beforeSendLog`, #1926).
 *
 * Drops verbose `debug` / `trace` logs in production to preserve log quota and
 * scrubs `log.message` + `log.attributes` for PII and credentials before transport.
 */
export function scrubSentryLog<T extends ScrubberLog>(log: T): T | null {
  if (
    (log.level === "debug" || log.level === "trace") &&
    isProductionEnvironment()
  ) {
    return null;
  }
  if (typeof log.message === "string") {
    log.message = scrubStringValue(log.message);
  }
  if (log.attributes && typeof log.attributes === "object") {
    log.attributes = redactByKey(log.attributes, 0) as typeof log.attributes;
  }
  return log;
}
