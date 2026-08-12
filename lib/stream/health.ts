import {
  getStreamChatClient,
  isStreamConfigured,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";

export interface StreamHealth {
  configured: boolean;
  /** null when unconfigured — we never probed, so we do not know. */
  reachable: boolean | null;
  /** True when the shared circuit breaker is OPEN and we fast-failed. */
  breakerOpen: boolean;
  latencyMs?: number;
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
  if (!isStreamConfigured()) {
    return { configured: false, reachable: null, breakerOpen: false };
  }

  const startedAt = Date.now();
  try {
    await withStreamCircuitBreaker(() => getStreamChatClient().getAppSettings());
    return {
      configured: true,
      reachable: true,
      breakerOpen: false,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      breakerOpen: error instanceof StreamUnavailableError,
      latencyMs: Date.now() - startedAt,
    };
  }
}
