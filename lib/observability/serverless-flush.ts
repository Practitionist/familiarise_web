/**
 * Server-only delivery for captured Sentry events.
 *
 * The SDK's transport is asynchronous and its own post-capture flush rides
 * Vercel's or Cloudflare's `waitUntil`, so on Netlify a function can freeze
 * the moment its response is returned with the envelope still queued. Inside
 * a request the flush rides `after()` (Netlify's `waitUntil`); outside one it
 * is returned for the caller to await. A timed-out flush is logged, so an
 * empty dashboard is distinguishable from a healthy one.
 */
import * as Sentry from "@sentry/nextjs";
import { after } from "next/server";

export const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

async function flushSentry(timeoutMs: number): Promise<void> {
  try {
    const drained = await Sentry.flush(timeoutMs);
    if (!drained) {
      console.warn(
        `[sentry] flush timed out after ${timeoutMs}ms; queued events were dropped`,
      );
    }
  } catch (err) {
    console.warn("[sentry] flush failed", err);
  }
}

/** Never throws: telemetry must not be the reason a response fails. */
export function scheduleSentryFlush(
  timeoutMs = SENTRY_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const flush = () => flushSentry(timeoutMs);
  try {
    after(flush);
    return Promise.resolve();
  } catch {
    return flush();
  }
}
