import {
  getStreamChatClient,
  getStreamCircuitStatus,
  isStreamConfigured,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { recordStreamOutage } from "@/lib/stream/system-event";

/**
 * #1280 / #1146 — the probe needs a deadline of its own.
 *
 * The chat client is a singleton built with one global `timeout: 30000`
 * (`lib/stream-client.ts`), `getAppSettings()` takes no arguments so there is no
 * per-request timeout or `AbortSignal` to narrow, and the circuit breaker's only
 * timing knob is `resetTimeout`, which governs OPEN→HALF_OPEN rather than the
 * operation. So the breaker delivers exactly the protection this file's docblock
 * promises for the SECOND probe of an outage and none at all for the first: in
 * the opening minutes, before enough failures accumulate, `/api/health` could
 * hang for a full thirty seconds on the endpoint whose entire purpose is to
 * report that outage quickly.
 *
 * Two seconds. A healthy `getAppSettings` is tens of milliseconds, and a health
 * check that takes longer than a couple of seconds has already failed at its job
 * whatever it eventually returns.
 */
const PROBE_TIMEOUT_MS = 2_000;

class StreamProbeTimeout extends Error {
  constructor() {
    super(`Stream health probe exceeded ${PROBE_TIMEOUT_MS}ms`);
    this.name = "StreamProbeTimeout";
  }
}

/**
 * Race `operation` against a deadline.
 *
 * Deliberately INSIDE the breaker rather than around it. A caller-side race
 * would return early and leave the breaker none the wiser, so the probe would
 * time out every time for the whole outage and never trip the thing that makes
 * subsequent probes cheap. Rejecting from within means the timeout counts as a
 * breaker failure, which is the entire point.
 *
 * It does not cancel the in-flight SDK request — `getAppSettings` exposes no
 * signal to cancel it with. The request is left to settle and its result
 * discarded. That is an accepted leak of one socket per probe during an outage,
 * and far cheaper than a 30-second health check.
 */
async function withDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StreamProbeTimeout()),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StreamHealth {
  configured: boolean;
  /** null when unconfigured — we never probed, so we do not know. */
  reachable: boolean | null;
  /**
   * True when Stream's circuit breaker is OPEN, read from the breaker's OWN
   * state.
   *
   * This field used to be derived from whether THIS probe's `getAppSettings()`
   * call happened to throw `StreamUnavailableError`, which is a different fact
   * and a much weaker one. The breaker is a closure created by
   * `createCircuitBreaker("stream")` in `lib/stream-client.ts` and its state
   * lives in that module instance, so on a COLD instance — which is the normal
   * state of a Netlify function — the count is zero, the breaker is CLOSED,
   * and the answer was `false` no matter how long the outage had been running.
   * It was a boolean that could only ever be `true` on the one warm instance
   * that had already absorbed five failures, and each of those was then
   * fast-failing THIS probe, so the field measured its own absence of data.
   */
  breakerOpen: boolean;
  /**
   * The breaker's state and failure count, so an operator can see "it has
   * failed twice" as distinct from "it is refusing". A boolean cannot express
   * the trend, and the trend is what tells you an outage is building.
   */
  breaker: { state: string; failures: number; lastFailure: string | null };
  /**
   * True when THIS probe never reached Stream because the breaker was already
   * open — the old meaning of `breakerOpen`, kept under its own name because it
   * is genuinely useful (it distinguishes "Stream said no" from "we did not
   * ask") and genuinely different from the field above.
   */
  probeFastFailed: boolean;
  /**
   * Whether the webhook secret `app/api/stream/webhooks/route.ts` will actually
   * verify against is set, and whether it is the API secret. Booleans only —
   * never the value, never a prefix, never a length. See
   * {@link getStreamWebhookSecretHealth}.
   */
  webhookSecret: StreamWebhookSecretHealth;
  /** True when the probe hit its own deadline rather than erroring. */
  timedOut?: boolean;
  latencyMs?: number;
}

/**
 * The 2026-08-12 outage, in one interface.
 *
 * Every webhook 401'd and nothing anywhere said so: the platform was green,
 * every cron was green, and the only symptom was ZERO `WebhookEvent` rows
 * appearing days later. The cause was never a code bug — the secret simply was
 * not set in the Netlify environment — and the code could not have told,
 * because every health check we had exercised `getAppSettings()`, which is
 * authenticated by the API secret. The HMAC path was never run.
 *
 * The route resolves its secret as
 * `STREAM_WEBHOOK_SECRET || STREAM_API_SECRET`, so there are exactly two ways to
 * be broken and they need different fixes:
 *
 *   - no API secret at all  → nothing Stream works, caught by `configured`.
 *   - an override set to something OTHER than the API secret → Stream signs
 *     with the API secret, the route verifies with the override, and every
 *     single delivery 401s. This is the silent one, and it is what
 *     `matchesApiSecret: false` names.
 *
 * An override EQUAL to the API secret is redundant, not broken, and is reported
 * as fine — otherwise the alarm would fire for a harmless belt-and-braces
 * setting.
 */
export interface StreamWebhookSecretHealth {
  /** A secret the webhook route will resolve to exists. */
  configured: boolean;
  /**
   * True when the resolved secret is the API secret — including the case where
   * no override is set, which resolves to the API secret BY CONSTRUCTION and is
   * therefore true by definition. `null` only when `configured` is false.
   */
  matchesApiSecret: boolean | null;
  /** Stable code for an alert rule; `null` when everything is in order. */
  reason: "API_SECRET_UNSET" | "WEBHOOK_SECRET_OVERRIDE_MISMATCH" | null;
  /** True when `STREAM_WEBHOOK_SECRET` is set at all (redundant if equal). */
  hasOverride: boolean;
}

/**
 * The webhook secret, as a BOOLEAN verdict. Never returns, logs, or Sentry-
 * reports the secret or any part of it.
 */
export function getStreamWebhookSecretHealth(): StreamWebhookSecretHealth {
  const apiSecret = process.env.STREAM_API_SECRET;
  const override = process.env.STREAM_WEBHOOK_SECRET;

  if (!apiSecret) {
    return {
      configured: false,
      matchesApiSecret: null,
      reason: "API_SECRET_UNSET",
      hasOverride: Boolean(override),
    };
  }

  // `STREAM_WEBHOOK_SECRET || STREAM_API_SECRET` — the exact expression the
  // route uses. Copied, not imported: the route is another agent's file and a
  // shared resolver would be a second source of truth for "which secret signs
  // a webhook", which is the thing that broke in August.
  const resolved = override || apiSecret;
  const matches = resolved === apiSecret;

  return {
    configured: true,
    matchesApiSecret: matches,
    // A missing override resolves to the API secret, so "unset" is not a
    // mismatch — only an override that DISAGREES with the API secret is.
    reason: matches ? null : "WEBHOOK_SECRET_OVERRIDE_MISMATCH",
    hasOverride: Boolean(override),
  };
}

/**
 * #473 — the health endpoint's Stream probe.
 *
 * The circuit breaker landed without anything reporting its state, so a Stream
 * outage stayed invisible until a user noticed chat was dead. This gives the
 * external monitor something to alert on, and — because the probe goes through
 * the breaker — an already-open breaker answers in microseconds rather than
 * making the health check itself hang for 30 seconds during the outage it is
 * supposed to be reporting.
 *
 * `getAppSettings` is the cheapest authenticated round-trip Stream offers: it
 * touches no user or channel data.
 */
export async function getStreamStatus(): Promise<StreamHealth> {
  // The breaker's own state, read BEFORE the probe. Reading it after would be
  // subtly wrong: the probe itself can trip the breaker, and then every answer
  // would report the state the probe just caused rather than the one it found.
  const breakerStatus = getStreamCircuitStatus();
  const breakerOpen = breakerStatus.state === "OPEN";
  const breaker = {
    state: breakerStatus.state,
    failures: breakerStatus.failures,
    lastFailure: breakerStatus.lastFailure
      ? new Date(breakerStatus.lastFailure).toISOString()
      : null,
  };
  const webhookSecret = getStreamWebhookSecretHealth();

  // A mis-signed webhook is not a health-check detail; it is a total, silent
  // outage of the integration (see the interface docblock). Reported twice, on
  // purpose and through two different systems: once to Sentry (so it is
  // findable) and once to `system_events` (so it is in the table engineering
  // reads when the dashboards are quiet). Before #E6 a total Stream outage
  // produced NO `SystemEvent` row at all, which is why the 2026-08-12 signature
  // was only ever discovered days later.
  //
  // `recordStreamOutage` is transition-gated and never throws, and it does not
  // feed the health verdict below — the verdict comes from the probe. A
  // monitoring write that could change a monitoring answer would be a new way
  // for the monitor to lie.
  await recordStreamOutage({
    probe: "webhook-secret",
    unhealthy: webhookSecret.reason !== null,
    reason: webhookSecret.reason ?? "OK",
    context: {
      hasOverride: webhookSecret.hasOverride,
      matchesApiSecret: String(webhookSecret.matchesApiSecret),
      configured: webhookSecret.configured,
    },
  });

  if (webhookSecret.reason) {
    captureThrottled(
      `stream-health:webhook-secret:${webhookSecret.reason}`,
      new Error(
        `Stream webhook secret is unusable: ${webhookSecret.reason}. ` +
          `STREAM_API_SECRET configured=${Boolean(process.env.STREAM_API_SECRET)}, ` +
          `STREAM_WEBHOOK_SECRET set=${webhookSecret.hasOverride}, ` +
          `overrideMatchesApiSecret=${String(webhookSecret.matchesApiSecret)}. ` +
          "No secret value is logged.",
      ),
      {
        subsystem: "stream",
        op: "health.webhookSecret",
        // warning, not error: nothing is broken RIGHT NOW in a way an
        // on-call can fix at 3am, but it is a config that must not ship.
        level: "warning",
        tags: { reason: `stream.webhook_secret.${webhookSecret.reason}` },
      },
    );
  }

  if (!isStreamConfigured()) {
    return {
      configured: false,
      reachable: null,
      breakerOpen,
      breaker,
      probeFastFailed: false,
      webhookSecret,
    };
  }

  const startedAt = Date.now();
  try {
    await withStreamCircuitBreaker(() =>
      withDeadline(() => getStreamChatClient().getAppSettings()),
    );
    // Reachability is its own outage class, and a SEPARATE one from the webhook
    // secret: one is a vendor being down, the other is a deployment that can
    // never have worked. Two rows, two different people who can fix them.
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: false,
      reason: "REACHABLE",
      context: { latencyMs: Date.now() - startedAt },
    });
    return {
      configured: true,
      reachable: true,
      // Re-read after a SUCCESSFUL probe: the probe has just proven Stream
      // answers, so a breaker still reading OPEN here is stale, and reporting
      // it as open would send someone to debug a breaker that is not refusing
      // anything.
      breakerOpen: false,
      breaker,
      probeFastFailed: false,
      webhookSecret,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    await recordStreamOutage({
      probe: "reachability",
      unhealthy: true,
      // Classified into the three reasons an operator can act on, rather than
      // the raw error: a vendor outage, a fast-fail, and a slow answer are three
      // different pages. `timedOut` is checked first because a timeout is
      // Stream being slow, not Stream being absent.
      reason:
        error instanceof StreamProbeTimeout
          ? "PROBE_TIMEOUT"
          : error instanceof StreamUnavailableError
            ? "CIRCUIT_OPEN"
            : "UNREACHABLE",
      context: {
        timedOut: error instanceof StreamProbeTimeout,
        breakerState: breakerStatus.state,
        breakerFailures: breakerStatus.failures,
      },
    });
    return {
      configured: true,
      reachable: false,
      // The breaker's state, NOT the failure's own type. Before this the field
      // was `error instanceof StreamUnavailableError`, which on a cold instance
      // could only ever be false — the breaker a fresh Netlify instance owns
      // has zero failures, so it never fast-fails, so the field that existed to
      // surface it never surfaced anything.
      breakerOpen,
      breaker,
      probeFastFailed: error instanceof StreamUnavailableError,
      webhookSecret,
      timedOut: error instanceof StreamProbeTimeout,
      latencyMs: Date.now() - startedAt,
    };
  }
}
