import * as Sentry from "@sentry/nextjs";
import { after } from "next/server";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// The SDK's own post-capture flush rides Vercel's or Cloudflare's waitUntil and
// does nothing on Netlify, where the function can freeze with the envelope still
// in flight. Hand the flush to Next's waitUntil; with no request scope, return
// it so Next awaits it before the response ends.
export function onRequestError(
  ...args: Parameters<typeof Sentry.captureRequestError>
): Promise<void> {
  Sentry.captureRequestError(...args);
  const flushed = Sentry.flush(2_000).then(
    () => undefined,
    () => undefined,
  );
  try {
    after(flushed);
    return Promise.resolve();
  } catch {
    return flushed;
  }
}
