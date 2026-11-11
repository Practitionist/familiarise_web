// Browser-side Sentry loader and capture. Keep `@sentry/nextjs` and the shared
// config behind dynamic imports: this module is in the critical client chunk.

type SentryModule = typeof import("@sentry/nextjs");

export type ClientCaptureContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

// Crash loops before init must not pile up unbounded work; extra events are dropped.
export const MAX_QUEUED_CAPTURES = 10;

let loading: Promise<SentryModule> | null = null;
let loaded: SentryModule | null = null;
let queued = 0;

/** Imports and initialises Sentry once; every caller shares the same promise. */
export function ensureSentry(): Promise<SentryModule> {
  loading ??= Promise.all([
    import("../../sentry.shared.config"),
    import("@sentry/nextjs"),
  ]).then(([shared, Sentry]) => {
    shared.initSentry();
    loaded = Sentry;
    return Sentry;
  });
  return loading;
}

function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Captures now when Sentry is initialised; otherwise starts the lazy init and
 * sends once it lands. Returns the event id, or undefined when the queue is full.
 */
export function captureClientException(
  error: unknown,
  context: ClientCaptureContext = {},
): string | undefined {
  const eventId = newEventId();
  const hint = { event_id: eventId, captureContext: context };
  if (loaded) {
    loaded.captureException(error, hint);
    return eventId;
  }
  if (queued >= MAX_QUEUED_CAPTURES) return undefined;
  queued += 1;
  ensureSentry()
    .then((Sentry) => {
      Sentry.captureException(error, hint);
    })
    .catch(() => {
      // Telemetry load failures (ad-blockers, offline) must not surface.
    })
    .finally(() => {
      queued -= 1;
    });
  return eventId;
}
