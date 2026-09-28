/**
 * Sentry ingest canary — is Sentry actually ACCEPTING our error events?
 *
 * ## Why this exists
 *
 * On 2026-09-22 the organisation's error quota was exhausted (the Upstash
 * request-cap incident the day before put ~5,000 events through the Developer
 * plan's 5,000/month allowance in a single day). Sentry kept *accepting* the
 * HTTP envelope and answered `200 {}` for session and transaction items while
 * answering the error items with:
 *
 *     429  x-sentry-rate-limits: …organization:error_usage_exceeded
 *
 * Every SDK does the polite thing: drop the event, retry after `retry-after`,
 * and never surface it to the application. So the app was healthy, the deploys
 * were green, the cron jobs were quiet, and **the error stream was empty for
 * six days**. Nothing in the product or the CI could tell, because the thing
 * that reports on errors is the thing that had stopped working.
 *
 * This is the only observability check in the system that can catch that
 * class of failure, and it has to report somewhere Sentry cannot throttle —
 * hence email, not Sentry.
 *
 * ## Why a raw fetch instead of the SDK
 *
 * `Sentry.captureException` + `flush()` cannot answer this. `flush()` returns
 * a boolean, not a reason, and a dropped event is indistinguishable from a
 * successful one from the caller's side. Posting a hand-built envelope
 * envelope-header pair straight at the ingest endpoint is the only way to read
 * the real status code and the `x-sentry-rate-limits` / `x-sentry-error`
 * headers that name the reason.
 *
 * ## What it deliberately is not
 *
 * It does not assert on anything in Sentry. There is no "the canary event
 * appeared in the UI" check here, because that check cannot run while ingest
 * is broken — which is precisely the moment it is needed. It asserts on the
 * ingest *response*, which is available even when storage is not.
 */

/**
 * Where the canary event is posted, derived from the DSN.
 *
 * Derived rather than hardcoded, for the same reason the rest of this branch
 * reads Sentry endpoints from the environment: a hardcoded host is a second
 * thing to change when the org moves region, and this file would then point at
 * somebody else's Sentry. The DSN already encodes both parts:
 *
 *     https://<publicKey>@<host>/<projectId>
 *
 * The host is used VERBATIM. Sentry Cloud DSNs already carry the collector
 * subdomain — `o<orgId>.ingest.<region>.sentry.io` — and a self-hosted DSN
 * points straight at the collector. Rewriting it (an earlier draft prepended
 * `ingest.` when the host did not *start* with it) produced
 * `ingest.o4509348815372289.ingest.us.sentry.io`, which resolves to nothing:
 * the `ingest.` label sits mid-host, not at the front. Only live testing finds
 * that, because the DNS failure is a clean `fetch failed` rather than an HTTP
 * status.
 */
export function envelopeEndpointFromDsn(dsn: string): {
  url: string;
  publicKey: string;
} | null {
  try {
    const parsed = new URL(dsn);
    const publicKey = parsed.username;
    const projectId = parsed.pathname.replace(/^\//, "");
    if (!publicKey || !projectId || !parsed.host) return null;
    const url = new URL(`https://${parsed.host}/api/${projectId}/envelope/`);
    url.searchParams.set("sentry_version", "7");
    url.searchParams.set("sentry_key", decodeURIComponent(publicKey));
    return { url: url.toString(), publicKey: decodeURIComponent(publicKey) };
  } catch {
    return null;
  }
}

/** Bound so a hung Sentry cannot hold a Netlify function open. */
const PROBE_TIMEOUT_MS = 10_000;

/** One event per run; the fingerprint pins it to a single non-noisy issue. */
const CANARY_FINGERPRINT = ["sentry-ingest-canary"];

export type IngestVerdict =
  /** 2xx — Sentry is taking error events. */
  | "accepted"
  /** 2xx but the body says the item was dropped. Some Sentry 200s carry a reason. */
  | "dropped-despite-2xx"
  /** 429 — throttled or over quota. `detail` carries Sentry's own words. */
  | "rate-limited"
  /** 401/403 — the DSN or key is wrong. */
  | "rejected-auth"
  /** 5xx or transport failure — Sentry is unwell, or we cannot reach it. */
  | "unavailable";

export interface IngestProbeResult {
  verdict: IngestVerdict;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** Sentry's own explanation, when it sent one. */
  detail: string | null;
  /**
   * The raw `x-sentry-rate-limits` header. This is the one piece of evidence
   * that distinguishes "we are being throttled right now" from "the org has
   * exceeded its allowance for the billing period", which look identical from
   * the status code alone and need completely different responses.
   */
  rateLimits: string | null;
  /** The event id we sent, so an operator can find the canary in the UI. */
  eventId: string;
}

/**
 * Post one real error envelope and classify the response.
 *
 * `send` is injected so a test can drive every branch without a network, and
 * so this module carries no import-time dependency on a live DSN.
 */
export async function probeSentryIngest(opts?: {
  send?: typeof defaultSend;
  dsn?: string;
  url?: string;
  eventId?: string;
  now?: Date;
}): Promise<IngestProbeResult> {
  const send = opts?.send ?? defaultSend;
  const dsn = opts?.dsn ?? process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
  const derived = envelopeEndpointFromDsn(dsn);
  // A DSN that will not parse means the app is not sending errors either, so
  // the canary reports that rather than silently posting nowhere.
  const url = opts?.url ?? derived?.url;
  const eventId = opts?.eventId ?? newEventId();
  const now = opts?.now ?? new Date();

  if (!url) {
    return {
      verdict: "rejected-auth",
      status: 0,
      detail:
        "NEXT_PUBLIC_SENTRY_DSN is unset or unparseable, so no error event " +
        "can be sent at all. The SDK is disabled in this deployment.",
      rateLimits: null,
      eventId,
    };
  }

  // The envelope is the real thing on purpose: a hand-rolled POST that Sentry
  // accepts is proof the endpoint and key work, which is the whole question.
  const envelope = buildErrorEnvelope({ eventId, timestamp: now });

  try {
    const res = await send(url as string, envelope);
    const detail = await readDetail(res);
    const rateLimits = res.headers?.get?.("x-sentry-rate-limits") ?? null;

    if (res.status === 429) {
      return {
        verdict: "rate-limited",
        status: 429,
        detail,
        rateLimits,
        eventId,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        verdict: "rejected-auth",
        status: res.status,
        detail,
        rateLimits,
        eventId,
      };
    }
    if (res.ok) {
      // Sentry sometimes answers 200 and reports a drop in the body. Treating
      // a 200 as success is how this failure mode stayed invisible for six
      // days, so the body is read rather than assumed.
      const dropped = detail?.includes("dropped data") ?? false;
      return {
        verdict: dropped ? "dropped-despite-2xx" : "accepted",
        status: res.status,
        detail,
        rateLimits,
        eventId,
      };
    }
    return {
      verdict: "unavailable",
      status: res.status,
      detail,
      rateLimits,
      eventId,
    };
  } catch (err) {
    return {
      verdict: "unavailable",
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
      rateLimits: null,
      eventId,
    };
  }
}

/** True only when error events are genuinely being taken. */
export function isIngestHealthy(r: IngestProbeResult): boolean {
  return r.verdict === "accepted";
}

/**
 * A one-line, operator-readable explanation. Written to be pasted into an
 * email subject / chat without editing.
 */
export function describeIngest(r: IngestProbeResult): string {
  switch (r.verdict) {
    case "accepted":
      return "Sentry is accepting error events.";
    case "rate-limited":
      return [
        "Sentry is REJECTING error events (429).",
        r.rateLimits ? ` Rate limits: ${r.rateLimits}.` : "",
        r.detail ? ` Sentry said: ${r.detail}` : "",
        " If the rate-limit header mentions `error_usage_exceeded`, the",
        " organisation's error allowance for the billing period is spent and",
        " every error is being discarded — raising the plan (Team includes 50k",
        " errors/month vs 5k on Developer) raises the ceiling immediately, so",
        " this does not have to wait for the period to roll over.",
      ].join("");
    case "rejected-auth":
      return `Sentry rejected the event (${r.status}) — the DSN or public key is wrong or revoked. ${r.detail ?? ""}`.trim();
    case "dropped-despite-2xx":
      return `Sentry answered 200 but dropped the event. ${r.detail ?? ""}`.trim();
    case "unavailable":
      return `Could not reach Sentry ingest (status ${r.status}). ${r.detail ?? ""}`.trim();
  }
}

function newEventId(): string {
  // 32 hex chars, the shape Sentry expects. `crypto` is available in the Node
  // and edge runtimes this runs in.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a minimal, valid Sentry error envelope.
 *
 * Deliberately carries NO user, org, IP or url: this is an infrastructure
 * check, and it should never become a record of anything about a person. The
 * identity it verifies is Sentry's own willingness to receive events, which
 * `lib/observability/identity.ts` covers separately.
 */
export function buildErrorEnvelope(opts: {
  eventId: string;
  timestamp: Date;
}): string {
  const event = {
    event_id: opts.eventId,
    timestamp: opts.timestamp.toISOString(),
    platform: "javascript",
    level: "error",
    logger: "sentry-ingest-canary",
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "canary",
    // A fixed fingerprint groups every canary run into one issue instead of
    // minting a new one per run.
    fingerprint: CANARY_FINGERPRINT,
    exception: {
      values: [
        {
          type: "SentryIngestCanary",
          value: "ingest canary — safe to ignore, this is a liveness probe",
          stacktrace: { frames: [] },
        },
      ],
    },
    tags: { subsystem: "canary", op: "sentry-ingest-canary" },
  };
  return (
    `${JSON.stringify({
      event_id: opts.eventId,
      sent_at: opts.timestamp.toISOString(),
      sdk: { name: "familiarise.ingest-canary", version: "1" },
    })}\n` +
    `${JSON.stringify({ type: "event" })}\n` +
    `${JSON.stringify(event)}\n`
  );
}

async function readDetail(res: {
  text?: () => Promise<string>;
}): Promise<string | null> {
  try {
    if (typeof res.text !== "function") return null;
    const body = await res.text();
    if (!body) return null;
    try {
      const parsed = JSON.parse(body) as {
        detail?: unknown;
        message?: unknown;
      };
      const d = parsed?.detail ?? parsed?.message;
      return typeof d === "string" ? d : body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  } catch {
    return null;
  }
}

const defaultSend = async (url: string, body: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
};
