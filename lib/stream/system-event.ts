/**
 * Stream's `SystemEvent` categories — issue #1134 E6.
 *
 * ## Why this is a new file and not a constant in `lib/enterprise/system-events.ts`
 *
 * `recordSystemError`'s `category` is a free-form string, so there is no enum to
 * extend and nothing that fails to compile when a category is missing. That is
 * precisely the problem: a Stream outage produced NO `SystemEvent` row at all,
 * not because the category was rejected but because nothing in the Stream
 * subsystem ever called the recorder. `SystemEvent` is the table engineering
 * reads when the dashboards are quiet — the money rows, the entitlement rows,
 * the audit rows all land there — and a total video outage was invisible in it.
 *
 * Putting the constants here rather than in the enterprise module keeps the
 * Stream-side vocabulary in the Stream-side tree, and means the `STREAM` and
 * `VIDEO` names are stated once, in the file whose subsystem owns them. The
 * admin reader (`/api/admin/system-events`) filters on a plain string, so
 * adding categories is a no-op there and needs no migration — `category` is
 * `String` in the schema, indexed, unconstrained.
 *
 * ## Why there are two, not one
 *
 * Stream bills and fails on two separate products under one API key: Chat (by
 * MAU) and Video (by participant-minute, and by availability). A 429 on a
 * `queryChannels` and a 5xx on `startRecording` have different causes, different
 * fixes, and different people who can apply them — and folding them into one
 * `STREAM` bucket would make a video-only outage look like a chat one on a
 * dashboard that only shows the category. This mirrors the split #1280 2.1 drew
 * between the two circuit breakers, for the same reason.
 */
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";

/** Chat-plane failure: channels, messages, users, tokens. */
export const STREAM_EVENT_CATEGORY = "STREAM" as const;

/** Video-plane failure: calls, participants, recordings, egress. */
export const VIDEO_EVENT_CATEGORY = "VIDEO" as const;

/**
 * Record a Stream/Video failure as a `SystemEvent` row AND escalate it to
 * Sentry, in one call.
 *
 * Returns the never-rejecting promise from `recordSystemErrorSafe`, so a
 * `void`-style call site is safe and an awaited one is not paying for an
 * unhandled rejection. `recordSystemErrorSafe` (not `recordSystemError`) is
 * deliberate: this is called from catch blocks on request paths, and the plain
 * version's contract is "throws if the row write fails" — an audit-write failure
 * inside a Stream error handler would then mask the Stream error, which is the
 * precise inversion of what an observability helper is for.
 *
 * `context` is free-form and lands in the JSON column. Do NOT put a Stream error
 * `message` in it verbatim: the SDK's messages can echo channel ids, user ids
 * and occasionally a token. Pass the coarse facts — status, error code, the
 * operation name — and let the message carry the prose.
 */
export function recordStreamSystemError(params: {
  /** Which product failed. See the two constants above. */
  category: typeof STREAM_EVENT_CATEGORY | typeof VIDEO_EVENT_CATEGORY;
  /** Human prose, e.g. "Stream video call lookup failed". */
  summary: string;
  err: unknown;
  /**
   * Coarse facts only — never a secret and never a raw SDK message.
   *
   * This is also where the OPERATION NAME belongs. `recordSystemError` has no
   * `op` parameter, so a wrapper that accepted one and forwarded it would be
   * accepting a value it silently discards — and a silently discarded field is
   * worse than an absent one, because the next reader assumes it was recorded.
   * Put it in `context` where it lands in the JSON column and stays queryable.
   */
  context?: Record<string, unknown>;
  organizationId?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  return recordSystemErrorSafe({
    organizationId: params.organizationId ?? null,
    category: params.category,
    summary: params.summary,
    err: params.err,
    context: params.context,
    correlationId: params.correlationId,
  });
}

export { recordStreamSystemError as default };

// ─────────────────────────────────────────────────────────────────────────────
// The outage ledger — the reason the categories above exist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum gap between two outage rows of the SAME kind, per instance.
 *
 * A transition-gated writer alone would still write a row every time a COLD
 * instance probes a broken Stream and has no memory of the last probe — which
 * on Netlify is most of them. Fifteen minutes bounds that to ~4 rows/hour per
 * instance while still being fast enough that an operator reading the table sees
 * the outage start, not a smear of identical rows.
 */
const OUTAGE_ROW_MIN_GAP_MS = 15 * 60 * 1000;

/**
 * Per-instance memory of the last state written.
 *
 * Deliberately in-process, for the same reason the Sentry infra throttle and the
 * usage read cache are: the alternative is to make "did we already record this"
 * depend on the dependency that is broken. The cost is that N warm instances can
 * each write one row per gap window, which is bounded and visible, and the
 * benefit is that a Stream outage cannot be made worse by the act of recording
 * it.
 */
let lastWritten: { unhealthy: boolean; at: number } | null = null;

/** Test-only: forgets the last written state. */
export function resetStreamOutageLedgerForTesting(): void {
  lastWritten = null;
}

/**
 * Record a Stream-integration outage to `system_events`, on TRANSITION.
 *
 * ## Why this exists
 *
 * `SystemEvent` is the table engineering reads when the dashboards are quiet,
 * and a total Stream outage left nothing in it. Every symptom was somewhere
 * else and none of them paged: no `WebhookEvent` rows, no `MeetingAttendance`
 * rows, a green `/api/health`, and — because `console.*` is stripped from the
 * Netlify function log (#1122) — no console line either. That combination is the
 * 2026-08-12 outage in full, and the categories above are worthless unless
 * something actually writes them.
 *
 * ## Transition-gated, and why that matters
 *
 * `/api/health` is polled every few minutes by an external monitor. A row per
 * poll would fill the table with the same fact and make the table useless for
 * the transitions it exists to record. So:
 *
 *   - a healthy → unhealthy transition writes one row;
 *   - an unhealthy → healthy transition writes one RECOVERY row (without which
 *     an operator cannot tell an outage that ended from one that is still open,
 *     and "when did it come back" is the first question asked);
 *   - a repeat inside {@link OUTAGE_ROW_MIN_GAP_MS} writes nothing.
 *
 * ## Never throws, never blocks, never decides the health verdict
 *
 * The caller is a health check on the request path. An observability write that
 * could fail one, or that could turn a warning into a 500, is worse than no
 * write at all — so this swallows everything, and the health route's own verdict
 * is computed from the probe, never from whether this succeeded.
 */
export async function recordStreamOutage(params: {
  /** What the probe concluded. */
  unhealthy: boolean;
  /** Stable, non-secret discriminator, e.g. a reason code. */
  reason: string;
  /** Which product. Chat for the webhook/breaker cases, video for call health. */
  category?: typeof STREAM_EVENT_CATEGORY | typeof VIDEO_EVENT_CATEGORY;
  /** Extra coarse facts. Never a secret and never a raw SDK message. */
  context?: Record<string, unknown>;
}): Promise<void> {
  const now = Date.now();
  const previous = lastWritten;
  const withinGap =
    previous !== null && now - previous.at < OUTAGE_ROW_MIN_GAP_MS;
  // Same state inside the gap: the common case, and the one that would otherwise
  // write a row per poll.
  if (
    previous !== null &&
    previous.unhealthy === params.unhealthy &&
    withinGap
  ) {
    return;
  }
  lastWritten = { unhealthy: params.unhealthy, at: now };

  const recovering = params.unhealthy === false;
  try {
    await recordStreamSystemError({
      category: params.category ?? STREAM_EVENT_CATEGORY,
      summary: recovering
        ? "Stream integration reachable again"
        : `Stream integration unreachable (${params.reason})`,
      // The reason doubles as the error object: `SystemEvent.message` is the
      // prose an operator reads and `context` carries the machine facts. A
      // synthetic Error keeps the two channels the same shape as every other
      // call site, which is what makes the table queryable by category.
      err: new Error(
        recovering
          ? `Stream health probe recovered: ${params.reason}`
          : `Stream health probe failed: ${params.reason}`,
      ),
      context: {
        // `op` has no dedicated column on `recordSystemError`, so it travels in
        // `context` — see the note on `recordStreamSystemError`. Recorded as a
        // data field rather than dropped, because "which probe wrote this" is
        // the first thing a reader of the table asks.
        ...(params.context ?? {}),
        op: "health.streamOutage",
        reason: params.reason,
        recovering,
      },
    });
  } catch {
    // `recordSystemErrorSafe` already swallows; this is belt-and-suspenders for
    // a getter throwing inside a params spread, which is the one way that
    // never-reject contract can be broken.
  }
}
