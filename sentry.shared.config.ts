// Shared Sentry.init() for all three runtimes (server / edge / client).
//
// The three Sentry entrypoints used to carry byte-identical init config; they
// differ only in that the client also exports onRouterTransitionStart. This
// centralizes the one config so a sampling/PII/env tweak lands in one place. (#913)

import * as Sentry from "@sentry/nextjs";
import { isExpectedError } from "@/lib/observability/expected";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentryLog,
  scrubSentrySpan,
} from "@/lib/observability/sentry-scrubber";
import {
  isNotDevelopmentEnvironment,
  isProductionEnvironment,
} from "@/utils/env";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

/**
 * Route-aware trace sampling (#1926):
 * - Non-production: 100%
 * - Health probes & static assets (`/api/health`, `/_next/`, `/favicon.ico`, `/robots.txt`): 0%
 * - Background cleanup cron endpoints (`/api/cleanup/`): 2%
 * - Critical payment, checkout, and webhook routes (`/api/webhooks/`, `/api/payments/`, `/api/checkout`): 50% (or parent decision)
 * - Default production baseline: 10% (or parent decision)
 */
export function tracesSampler(
  samplingContext: Parameters<
    NonNullable<SentryInitOptions["tracesSampler"]>
  >[0],
): number {
  if (!isProductionEnvironment()) return 1;
  const rawName =
    samplingContext.name ||
    (typeof samplingContext.attributes?.["http.target"] === "string"
      ? samplingContext.attributes["http.target"]
      : "") ||
    samplingContext.normalizedRequest?.url ||
    "";
  if (
    rawName.includes("/api/health") ||
    rawName.includes("/_next/") ||
    rawName.includes("/favicon.ico") ||
    rawName.includes("/robots.txt")
  ) {
    return 0;
  }
  if (rawName.includes("/api/cleanup/")) {
    return 0.02;
  }
  if (
    rawName.includes("/api/webhooks/") ||
    rawName.includes("/api/payments/") ||
    rawName.includes("/api/checkout")
  ) {
    if (typeof samplingContext.parentSampled === "boolean") {
      return samplingContext.parentSampled ? 1 : 0;
    }
    return 0.5;
  }
  if (typeof samplingContext.parentSampled === "boolean") {
    return samplingContext.parentSampled ? 1 : 0;
  }
  return 0.1;
}

/**
 * Quota guard: an infra outage must not eat the monthly errors budget to
 * report itself. 2026-09-21: the Upstash 500k request cap produced 2,147
 * UpstashError + ~900 CronLockUnavailableError events in 24h — 80% of the
 * 5,000-error quota — all saying the same thing, while real defects queued
 * behind them. Fail-closed refusals already surface via exit codes + the
 * Actions failure pager; Sentry needs a trickle per error class (one event
 * per window), not a firehose. Keyed by class only, deliberately not by
 * route: during a global outage every route reports the same underlying
 * fact, and per-route trickles would still scale with the fleet.
 *
 * Deliberately process-local, not Redis-backed: Redis IS the outage this
 * guards — a shared limiter needs the downed dependency to answer, and must
 * then fail open (restoring the firehose) or fail closed (dropping
 * legitimate errors). Bound: warm instances × 6/hr/class, versus ~3,000/hr
 * unthrottled during the 2026-09-21 outage. The complementary server-side
 * inbound filter (dashboard-side, drops before quota) is the follow-up.
 */
export const INFRA_THROTTLE_MS = 10 * 60 * 1000;
export const INFRA_TRANSIENT_PATTERNS = [
  /max requests limit exceeded/i, // Upstash quota wall
  /CronLockUnavailableError/, // fail-closed lock refusal (pager already fires)
  // #1868 — a failed `SystemEvent` audit write (lib/enterprise/system-events.ts).
  // Keyed on that module's exported marker so it trickles per class per window
  // instead of once per call site; a systemic database outage fails every
  // write at once, which is the same flood shape as 2026-09-21. Deliberately
  // scoped to the marker rather than to a database-error pattern, which would
  // also swallow genuine faults elsewhere.
  /\[system-events\] write failed/,
];

export function infraThrottleKey(event: {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string }> };
}): string | null {
  const text = [
    event.message ?? "",
    ...(event.exception?.values ?? []).map(
      (v) => `${v.type ?? ""}: ${v.value ?? ""}`,
    ),
  ].join(" | ");
  const hit = INFRA_TRANSIENT_PATTERNS.find((re) => re.test(text));
  return hit ? hit.source : null;
}

// #1933 — the free plan allows 5,000 errors a month and 2026-09-22 spent all
// of it, leaving ten days dark. These three guards bound what one process can
// send; they are in-memory on purpose, because Redis is often what is down.
const BUDGET_MAX_KEYS = 500;
const BUDGET_BREAKER_MAX = 30;
const BUDGET_BREAKER_WINDOW_MS = 60 * 60 * 1000;

// Named fingerprint families: one issue and one throttle key per class, however
// many routes hit it. The first three reuse INFRA_TRANSIENT_PATTERNS.
const FAMILY_FOR_PATTERN: Record<string, string> = {
  [INFRA_TRANSIENT_PATTERNS[0].source]: "upstash-quota",
  [INFRA_TRANSIENT_PATTERNS[1].source]: "cron-lock-unavailable",
  [INFRA_TRANSIENT_PATTERNS[2].source]: "system-events-write-failed",
};
const POOL_EXHAUSTION_TEXT =
  /Unable to start a transaction in the given time|Timed out fetching a new connection from the connection pool|\bP2024\b/;

const budgetLastSent = new Map<string, number>();
let breakerSent: number[] = [];
let breakerDropped = 0;

/** Test seam: clears the process-local budget state. */
export function resetSentryBudgetState(): void {
  budgetLastSent.clear();
  breakerSent = [];
  breakerDropped = 0;
}

function eventText(event: Sentry.Event): string {
  return [
    event.message ?? "",
    ...(event.exception?.values ?? []).map(
      (v) => `${v.type ?? ""}: ${v.value ?? ""}`,
    ),
  ].join(" | ");
}

function fingerprintFamily(event: Sentry.Event): string | null {
  const infra = infraThrottleKey(event);
  if (infra !== null) return FAMILY_FOR_PATTERN[infra] ?? null;
  if (event.tags?.pool_exhaustion === "true") return "prisma-pool-exhaustion";
  return POOL_EXHAUSTION_TEXT.test(eventText(event))
    ? "prisma-pool-exhaustion"
    : null;
}

function normaliseForKey(text: string): string {
  return text
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "#",
    )
    .replace(/\bc[a-z0-9]{24}\b/g, "#")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#");
}

function budgetKey(event: Sentry.Event, family: string | null): string {
  if (family) return `family:${family}`;
  const ex = event.exception?.values?.at(-1);
  if (!ex) return `msg:${normaliseForKey(event.message ?? "")}`;
  const frames = ex.stacktrace?.frames ?? [];
  const top = [...frames].reverse().find((f) => f.in_app) ?? frames.at(-1);
  const where = top ? `${top.filename ?? ""}:${top.function ?? ""}` : "";
  return `${ex.type ?? ""}|${normaliseForKey(ex.value ?? "")}|${where}`;
}

/**
 * True when the event should be dropped: first per key passes, then one per
 * INFRA_THROTTLE_MS per key; and at most BUDGET_BREAKER_MAX events an hour per
 * process get through whatever their key. Throttled events do not feed the
 * breaker, so a flood of one class cannot starve a different real fault.
 * `fatal` events skip the breaker (owner decision on #1938): a money page like
 * WALLET_BALANCE_DRIFT must not lose to an hour of unrelated noise; the per-key
 * throttle still bounds a fatal flood.
 */
function exceedsErrorBudget(
  key: string,
  fatal: boolean,
  now = Date.now(),
): boolean {
  const last = budgetLastSent.get(key);
  if (last !== undefined && now - last < INFRA_THROTTLE_MS) return true;

  breakerSent = breakerSent.filter((t) => now - t < BUDGET_BREAKER_WINDOW_MS);
  if (!fatal && breakerSent.length >= BUDGET_BREAKER_MAX) {
    if (breakerDropped === 0) {
      console.warn(
        `[sentry] per-process breaker open: >${BUDGET_BREAKER_MAX} events/hour, dropping the rest (#1933)`,
      );
    }
    breakerDropped += 1;
    return true;
  }
  if (breakerDropped > 0) {
    console.warn(
      `[sentry] breaker closed: dropped ${breakerDropped} events in the last window (#1933)`,
    );
    breakerDropped = 0;
  }

  if (!fatal) breakerSent.push(now);
  budgetLastSent.delete(key); // re-insert so Map order stays oldest-first
  budgetLastSent.set(key, now);
  if (budgetLastSent.size > BUDGET_MAX_KEYS) {
    const oldest = budgetLastSent.keys().next().value;
    if (oldest !== undefined) budgetLastSent.delete(oldest);
  }
  return false;
}

/** The `beforeSend` budget stage, exported so a test can drive it directly. */
export function applyErrorBudget(event: Sentry.Event): Sentry.Event | null {
  // #1933 — an expected outcome at info level is an ANSWER, not a fault.
  if (event.tags?.expected === "true" && event.level === "info") return null;
  const family = fingerprintFamily(event);
  if (family) event.fingerprint = [family];
  return exceedsErrorBudget(budgetKey(event, family), event.level === "fatal")
    ? null
    : event;
}

/**
 * `overrides` is layered on last and exists for ONE caller: the cron-job runner
 * in lib/observability/job-sentry.ts, which runs in a bare Node process where
 * NODE_ENV is unset and so the gating below reads differently than it does for
 * the app. No app entrypoint passes it, so their behaviour is unchanged. (#1066)
 */
/**
 * Strip the fields `dataCollection` does not gate.
 *
 * Measured on the wire, 2026-09-29, against 10.59.0 / 10.75.3 / 11.1.0 with
 * this repo's exact config: `contexts.culture.timezone` arrives in every
 * version, on the event AND on the transaction. Nothing in `dataCollection`
 * controls it, so the only place to remove it is a send hook.
 *
 * A timezone is a coarse location signal — `Asia/Kolkata` narrows a principal
 * to a country of a few hundred million — so it is personal data in a way the
 * cuid discussion does not reach, and it was being sent while the disclosure
 * switch was believed to be the only thing leaving.
 *
 * #1916 / #1879: `beforeSendSpan` (`scrubSentrySpan`) now strips `culture.timezone`
 * and scrubs PII on spans in 10.75.x. `@sentry/nextjs` remains pinned on 10.75.x
 * rather than 11.x because v11 switches `dataCollection` defaults to permissive
 * (`userInfo: true`, `urlQueryParams: true` with no `queryParams` fallback) and
 * alters the span streaming hook contract.
 */
function stripUngatedPII(event: Sentry.Event): Sentry.Event {
  const culture = event.contexts?.culture as
    | Record<string, unknown>
    | undefined;
  if (culture && "timezone" in culture) {
    // Reassign rather than mutate: the event object may be frozen downstream,
    // and a silent no-op on a frozen object is how this would go unnoticed.
    event.contexts = {
      ...event.contexts,
      culture: Object.fromEntries(
        Object.entries(culture).filter(([k]) => k !== "timezone"),
      ),
    };
  }
  return event;
}

/**
 * The data-minimisation policy, as a named, testable artefact rather than an
 * inline literal.
 *
 * Exported so `__tests__/observability/sentry-data-collection.test.ts` can
 * assert the key SET rather than the behaviour. That distinction is the whole
 * point: measured on 2026-09-29 across 10.59.0 / 10.75.3 / 11.1.0, dropping a
 * single key here does not error, does not warn, and does not fail any existing
 * test. It silently resolves that category to a permissive default. A test that
 * asserts the keys exist is the only thing standing between an edit and a
 * privacy regression.
 */
export const SENTRY_DATA_COLLECTION: NonNullable<
  SentryInitOptions["dataCollection"]
> = {
  // No requester IP, no derived geo, no SDK-inferred user identity.
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  // BOTH keys, deliberately. The v10 name and the v11 name for the same
  // setting, kept side by side so the rename cannot become a silent
  // regression: `queryParams` is what v10 reads, `urlQueryParams` is what
  // v11 reads, and v11's resolver has NO fallback between them — it does
  // `urlQueryParams ?? DEFAULTS.urlQueryParams`, and the default is `true`.
  // So a v11 upgrade with only the old key silently starts shipping query
  // strings again, and the failure is not an error, just a default.
  // Dropping either key is a regression; `__tests__/observability/sentry-data-collection.test.ts`
  // fails if one goes.
  queryParams: false,
  urlQueryParams: false,
  // No request or response bodies, in either direction.
  httpBodies: [],
  // No local variable values in stack frames.
  stackFrameVariables: false,
  // No generative-AI prompt or completion content. This app issues no
  // model calls today; pinned so adding one cannot start shipping them.
  genAI: { inputs: false, outputs: false },
};

export function initSentry(overrides?: Partial<SentryInitOptions>): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  Sentry.init({
    dsn,
    // No DSN => Sentry fully disabled. Also gated off in local `next dev` so a
    // developer's .env DSN doesn't flood the shared prod project with dev noise.
    enabled: Boolean(dsn) && isNotDevelopmentEnvironment(),
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,

    // #1933 — previews keep visibility at a tenth of the volume; everything
    // else reports every error (the throttle above bounds floods). Keyed on
    // "preview" rather than "not production" so an unset environment (a bare
    // job runner, a test) fails open instead of silently dropping 90%.
    sampleRate:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT === "preview" ? 0.1 : 1,

    // #1086 — deploy previews used to report to a SEPARATE Sentry project, so
    // an error found on a preview was invisible in the one anybody watches and
    // had to be dug out of Netlify function logs. They now share the production
    // project; `environment` ("preview" vs "production") keeps them out of
    // production alerting, and this tag says WHICH branch produced it.
    initialScope: {
      tags: {
        ...(process.env.NEXT_PUBLIC_SENTRY_BRANCH
          ? { branch: process.env.NEXT_PUBLIC_SENTRY_BRANCH }
          : {}),
      },
    },

    // Sample 10% of traces in production (with route-aware overrides via
    // tracesSampler); everything outside production.
    tracesSampleRate: isProductionEnvironment() ? 0.1 : 1,
    ...(overrides?.tracesSampleRate !== undefined ? {} : { tracesSampler }),

    // Send structured logs to Sentry.
    enableLogs: true,

    // Never attach PII to events.
    //
    // `sendDefaultPii: false` said this correctly, but the SDK deprecated it at
    // 10.54 in favour of the per-category `dataCollection` map, and the
    // installed resolver documents the trap explicitly
    // (`@sentry/core/utils/data-collection/resolveDataCollectionOptions`):
    //
    //   "In v10, DEFAULTS only apply when `dataCollection` is explicitly
    //    provided. When `dataCollection` is absent, the legacy `sendDefaultPii`
    //    bridge is used, which defaults to `userInfo: false` to preserve
    //    backward compatibility."  …  "TODO(v11): Remove `sendDefaultPii`
    //    support and always fall through to DEFAULTS so that `userInfo: true`
    //    will always apply."
    //
    // So this is load-bearing, not cosmetic. `dataCollection` is OPT-OUT and
    // `userInfo` is the ONLY field whose documented default is `false`; every
    // other field defaults to permissive. A partial object — or the SDK's own
    // v11 default — therefore silently starts sending data we never agreed to.
    // Every category we do not want is listed explicitly instead of relied
    // upon, so the intent survives an SDK upgrade.
    //
    // Two of these are not obvious and were worth pinning down:
    //  - `stackFrameVariables` defaults to TRUE, i.e. local variable VALUES
    //    are captured into server stack frames. In a Prisma codebase a frame
    //    routinely holds a `userId`, an email, or a whole row. Off.
    //  - `httpHeaders` is a `{ request, response }` object, not a bare boolean;
    //    `httpHeaders: false` is a type error, and getting the shape wrong
    //    would have left response headers on.
    //
    // This suppresses INFERENCE, not our own labelling: `Sentry.setUser` is an
    // explicit opt-in unaffected by every flag here, and is how
    // `lib/observability/identity.ts` attributes an event to a user. See
    // docs/observability/sentry/05-identity-and-triage.md.
    dataCollection: SENTRY_DATA_COLLECTION,
    // Source context lines are kept: `frameContextLines` (5 by default) is the
    // difference between a readable N+1 frame and a bare file/line, and the
    // surrounding source contains no tenant data.

    // Drop non-actionable third-party noise before it reaches the dashboard.
    // - "Connection closed." — RSC flight-stream abort when a client navigates
    //   away mid-stream (react-server-dom-webpack). (FAMILIARISE_WEB-E)
    // - "func ... not found" / inpage.js — injected browser wallet extensions
    //   throwing inside their own provider bridge on our pages. (FAMILIARISE_WEB-F)
    // - "Object Not Found Matching Id" — CefSharp / Outlook Safe Links bots
    //   rejecting non-Error promises while scanning our pages. (FAMILIARISE_WEB-Y)
    // Do NOT add the Prisma pooler-timeout strings here — but the reason changed
    // in #1119. Route-level fail-open no longer degrades them on the public
    // explore routes; those five now rethrow deliberately, so pooler timeouts are
    // EXPECTED there and this filter can no longer be read as "any occurrence is a
    // new unprotected route". Keep them unfiltered because they are the only
    // signal that the tail in #1124 is still happening; triage them by route
    // rather than by presence. (#932, #1119, #1124)
    ignoreErrors: [
      "Connection closed.",
      /func .* not found/,
      /inpage\.js/,
      /Object Not Found Matching Id/i,
      // #1933 — control-flow and browser noise that is never a defect.
      "NEXT_REDIRECT",
      "NEXT_NOT_FOUND",
      /AbortError/,
      /The (user|operation) aborted/,
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      /Non-Error promise rejection captured/,
    ],

    // Events whose top stack frame originates in an injected extension script
    // are never our code — drop them regardless of message.
    denyUrls: [
      /inpage\.js/,
      /extensions\//i,
      /^chrome-extension:\/\//i,
      /^moz-extension:\/\//i,
      /^safari-extension:\/\//i,
      /^safari-web-extension:\/\//i,
    ],

    // Errors captured by Next's `onRequestError` hook carry no per-call
    // options, so a guard that fires by design (an expired cookie reaching an
    // auth check) arrives looking like a fault. `markExpected` puts a marker on
    // the thrown error and this stamps the tag. Never drops an event — it only
    // re-levels one. (FAMILIARISE_WEB-10)
    beforeSend(event, hint) {
      stripUngatedPII(event);
      if (isExpectedError(hint?.originalException)) {
        event.level = "warning";
        event.tags = { ...event.tags, expected: "true" };
      }
      // #1933 quota guard: drop expected-info, fingerprint the flood families,
      // throttle per key, cap per process. Returning null drops before
      // transport, so dropped events never consume quota.
      if (applyErrorBudget(event) === null) return null;
      // #1861 S4 — scrub AFTER the relabel/throttle above: this pass only
      // removes data, it never changes a drop/keep or level decision.
      return scrubSentryEvent(event);
    },

    // #1861 S4 — same redaction as beforeSend, for the http/fetch
    // breadcrumbs Sentry auto-records (these carry their own headers/URL and
    // are not covered by beforeSend's event.request scrub).
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryBreadcrumb(breadcrumb);
    },

    // Transactions need their own hook: `beforeSend` is never called for them,
    // and the timezone was measured arriving on both. Same scrubber.
    beforeSendTransaction(event) {
      return scrubSentryEvent(stripUngatedPII(event)) as typeof event;
    },

    // #1916 / #1926 — spans carry `culture.timezone` and query/attribute data
    // outside `beforeSendTransaction`; scrub them before transport.
    beforeSendSpan(span) {
      return scrubSentrySpan(span);
    },

    // #1926 — drop verbose debug/trace logs in production and scrub PII from
    // structured Sentry logs before transport.
    beforeSendLog(log) {
      return scrubSentryLog(log);
    },

    // Last, so a caller can narrow a knob it has better information about.
    // Undefined spreads to nothing, which is what every app entrypoint does.
    ...overrides,
  });
}
