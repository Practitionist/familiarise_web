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
} from "@/lib/observability/sentry-scrubber";
import {
  isNotDevelopmentEnvironment,
  isProductionEnvironment,
} from "@/utils/env";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

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
  // #E4 — the Stream fast-fail. `StreamUnavailableError` is raised by
  // `withStreamCircuitBreaker` for EVERY Stream call made while the breaker is
  // open, and it is raised on the request path: a dashboard load fans out into
  // several Stream calls, so a 10-minute outage on a modest site is hundreds of
  // identical events saying one thing, which is the 2026-09-21 shape exactly.
  //
  // Its own class rather than folded into the `subsystem: stream` rule below, so
  // "the breaker is refusing" and "Stream returned a 5xx" stay
  // distinguishable — a fix that clears one of them is not a fix for the other.
  /Stream circuit breaker is OPEN/,
];

/**
 * #E4 — a Stream outage trickles instead of fire-hosing.
 *
 * This is the rule that stopped a Stream vendor incident from being an error
 * quota incident. It is keyed on the SUBSYSTEM TAG rather than on a message
 * pattern because the message is whatever the SDK said, and the tag is ours and
 * stable — `subsystem: "stream"` is what `withStreamCircuitBreaker`, the
 * meeting-join door and the recording door all set, so one rule covers every
 * Stream call site including the ones added after this was written.
 *
 * Two exclusions, both deliberate and both load-bearing:
 *
 *   - `reason: "stream.billing"` (Stream code 99, app suspended) is NOT
 *     throttled with the rest. It is the one Stream failure with a human action
 *     attached, it does not self-resolve, and it is rare — throttling it into
 *     the same bucket as a 429 is how the message "we owe Stream money" gets
 *     lost. It falls through to `STREAM_BILLING_EXEMPT` and pages as before.
 *   - Nothing is throttled on the strength of the tag ALONE unless the event is
 *     also transient-looking. See {@link isTransientStreamEvent}: a
 *     `subsystem: "stream"` account-state refusal (a deactivated user, a
 *     suspended app) is a DIFFERENT bug from a vendor 5xx and must keep
 *     producing its own issue, or fixing it will look like the throttle ate it.
 */
const STREAM_BILLING_EXEMPT = "stream.billing";

/**
 * Does this Stream event describe a VENDOR problem, as opposed to an account
 * state or a defect of ours?
 *
 * The distinction is the same one `lib/stream-client.ts` already draws in
 * `isExpectedStreamError` / `isRateLimitError` / `isStreamBillingError`: 404 is
 * an expected miss on the lazy create-or-join path, 429 is self-inflicted quota
 * exhaustion, 99 is a suspended app, and none of those are evidence that Stream
 * is having a bad time. A network error, a timeout and a 5xx are.
 *
 * Kept as a regex over the rendered text rather than as a status-code parse
 * because `infraThrottleKey` only ever sees the event's message and exception
 * values — the tag is available, the HTTP status is not.
 */
const STREAM_TRANSIENT_TEXT =
  /\b(429|500|502|503|504)\b|rate limit|too many requests|timeout|timed out|socket hang up|econnreset|econnrefused|etimedout|enotfound|network|fetch failed/i;

function isTransientStreamEvent(text: string, reason: string | undefined) {
  if (reason === STREAM_BILLING_EXEMPT) return false;
  return STREAM_TRANSIENT_TEXT.test(text);
}

const infraLastSent = new Map<string, number>();

export function infraThrottleKey(event: {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string }> };
  // Sentry's own `Event['tags']` values are `Primitive` (string | number |
  // boolean | null), not `string`. Only `subsystem` and `reason` are read below
  // and both are always strings, so the value type is widened here and the two
  // reads coerce — a `Primitive` that is not a string simply never matches, which
  // is the right answer for a tag we did not write.
  tags?: Record<string | symbol, unknown>;
}): string | null {
  const text = [
    event.message ?? "",
    ...(event.exception?.values ?? []).map(
      (v) => `${v.type ?? ""}: ${v.value ?? ""}`,
    ),
  ].join(" | ");
  const hit = INFRA_TRANSIENT_PATTERNS.find((re) => re.test(text));
  if (hit) return hit.source;

  // #E4 — see the note above. Read from the tag first and the text second, so
  // an event that is BOTH (a Stream fast-fail also matches the pattern above)
  // keys on the more specific class rather than on whichever check runs first.
  const tags = event.tags as Record<string, unknown> | undefined;
  const subsystem = tags?.subsystem;
  if (subsystem === "stream") {
    const reason = tags?.reason ?? tags?.["stream.failure"];
    if (
      isTransientStreamEvent(
        text,
        typeof reason === "string" ? reason : undefined,
      )
    ) {
      return "stream.subsystem";
    }
  }

  return null;
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
 * Known residual, stated rather than hidden: this does NOT cover spans. On
 * 10.75.x the span hook needs `beforeSendSpan`, and on v11 its signature
 * changed and could not be characterised reliably. Spans therefore still carry
 * the timezone until that is done. See the handoff issue.
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

    // Sample 10% of traces in production; everything outside production.
    tracesSampleRate: isProductionEnvironment() ? 0.1 : 1,

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
      // Quota guard (see INFRA_TRANSIENT_PATTERNS): drop the repeats, keep
      // one per class per window. Returning null drops before transport, so
      // throttled events never consume quota.
      const throttleKey = infraThrottleKey(event);
      if (throttleKey !== null) {
        const now = Date.now();
        if (now - (infraLastSent.get(throttleKey) ?? 0) < INFRA_THROTTLE_MS) {
          return null;
        }
        infraLastSent.set(throttleKey, now);
      }
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
      return stripUngatedPII(event) as typeof event;
    },

    // Last, so a caller can narrow a knob it has better information about.
    // Undefined spreads to nothing, which is what every app entrypoint does.
    ...overrides,
  });
}
