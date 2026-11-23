/**
 * Better Stack Telemetry (logs) ingest. Distinct from `lib/betterstack.ts`,
 * which talks to the Uptime and incident API.
 *
 * Every event is built from the fixed field set in {@link telemetryEventSchema}:
 * identifiers only, never names, emails or a caller's free-form context. A send
 * never throws; it resolves to a {@link TelemetryOutcome} that a run tallies on
 * its execution row, and a rejection is never reported to Sentry.
 */

import { z } from "zod";
import { ENTITY_ID_PATTERN } from "@/lib/observability/entity-id";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";

/** Ingest answers a run counts: 402 quota spent, 403 bad source token, 5xx, no answer, any other non-2xx. */
export type IngestRejection = "402" | "403" | "5xx" | "network" | "other";
export type TelemetryOutcome = "sent" | "skipped" | IngestRejection;

const SEND_TIMEOUT_MS = 2_000;
const MESSAGE_MAX_CHARS = 500;

const id = z.string().regex(ENTITY_ID_PATTERN);
const count = z.number().int().nonnegative();
const targetNames = z.array(z.string().max(64)).max(100);

/** Seconds the oldest item in each queue has waited past its due point; 0 means none is waiting. */
export const pendingAgesSchema = z
  .object({
    refundsOwed: count,
    payoutsStuck: count,
    dunningNotices: count,
    disputesDue: count,
    webhookEvents: count,
    emailRetries: count,
    notificationRetries: count,
    parkedCaptures: count,
  })
  .strict();
export type PendingAges = z.infer<typeof pendingAgesSchema>;

const telemetryEventSchema = z
  .object({
    dt: z.string().datetime(),
    level: z.enum(["info", "warn", "error"]),
    message: z.string().min(1).max(MESSAGE_MAX_CHARS),
    category: z.string().max(64).optional(),
    organization_id: id.optional(),
    correlation_id: z.string().max(200).optional(),
    job_run_id: id.optional(),
    entity_id: id.optional(),
    // The Sentry ingest canary's verdict.
    verdict: z.string().max(64).optional(),
    accepted: count.optional(),
    rejected: count.optional(),
    // The ticker's per-tick summary.
    tickId: z.string().uuid().optional(),
    durationMs: count.optional(),
    okCount: count.optional(),
    acceptedCount: count.optional(),
    lockHeld: targetNames.optional(),
    lockUnavailableCount: count.optional(),
    lockUnavailable: targetNames.optional(),
    failed: z
      .array(z.object({ name: z.string().max(64), status: count }).strict())
      .max(100)
      .optional(),
    skippedIdleCount: count.optional(),
    error: z.string().max(MESSAGE_MAX_CHARS).optional(),
    oldestPendingAgeS: pendingAgesSchema.optional(),
  })
  .strict();

export type TelemetryLog = Omit<z.input<typeof telemetryEventSchema>, "dt">;

/** The rejection bucket for an ingest HTTP status, or null for a 2xx. */
export function ingestRejectionOf(status: number): IngestRejection | null {
  if (status >= 200 && status < 300) return null;
  if (status === 402) return "402";
  if (status === 403) return "403";
  if (status >= 500) return "5xx";
  return "other";
}

type OutcomeSink = (sending: Promise<TelemetryOutcome>) => void;
let outcomeSink: OutcomeSink | null = null;

/** Installed by the run context so a job run counts its sends; leaf module, no Node imports. */
export function setTelemetryOutcomeSink(next: OutcomeSink): void {
  outcomeSink = next;
}

async function send(
  log: TelemetryLog,
  fetchImpl: typeof fetch,
): Promise<TelemetryOutcome> {
  // Read per call: the ticker keeps this module loaded across warm invocations.
  if (process.env.ENABLE_BETTERSTACK_TELEMETRY !== "true") return "skipped";
  const token = process.env.BETTERSTACK_SOURCE_TOKEN;
  const url = process.env.BETTERSTACK_INGEST_URL;
  if (!token || !url) {
    console.warn(
      "[BetterStack Telemetry] ENABLE_BETTERSTACK_TELEMETRY set but BETTERSTACK_SOURCE_TOKEN/BETTERSTACK_INGEST_URL missing; skipping",
    );
    return "skipped";
  }
  const event = telemetryEventSchema.safeParse({
    ...log,
    dt: new Date().toISOString(),
    message: scrubStringValue(log.message).slice(0, MESSAGE_MAX_CHARS),
    ...(log.correlation_id
      ? { correlation_id: scrubStringValue(log.correlation_id) }
      : {}),
    ...(log.error
      ? { error: scrubStringValue(log.error).slice(0, MESSAGE_MAX_CHARS) }
      : {}),
  });
  if (!event.success) {
    console.warn(
      JSON.stringify({
        event: "betterstack-event-invalid",
        issues: event.error.issues.map((issue) => issue.path.join(".")),
      }),
    );
    return "skipped";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event.data),
      signal: controller.signal,
    });
    const rejection = ingestRejectionOf(res.status);
    if (rejection === null) return "sent";
    console.warn(
      JSON.stringify({
        event: "betterstack-ingest-rejected",
        status: res.status,
        message: event.data.message,
      }),
    );
    return rejection;
  } catch {
    console.warn(
      JSON.stringify({
        event: "betterstack-ingest-unreachable",
        message: event.data.message,
      }),
    );
    return "network";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ships one event. Never throws: the outcome is `skipped` when telemetry is off
 * or the event is invalid, `sent` on a 2xx, and a rejection bucket otherwise.
 */
export function emitTelemetryLog(
  log: TelemetryLog,
  fetchImpl: typeof fetch = fetch,
): Promise<TelemetryOutcome> {
  const sending = send(log, fetchImpl).catch((): TelemetryOutcome => "network");
  outcomeSink?.(sending);
  return sending;
}
