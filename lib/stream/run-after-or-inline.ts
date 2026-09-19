import { after } from "next/server";

/**
 * #1589 M-P0-04 — `after()` throws synchronously (Next E468) when there is no
 * request scope, which is exactly what the sweeper's tsx re-drive is. The
 * ready handler kicks the transfer and the bell through `after()` AFTER the
 * Recording row exists, so a re-drive that threw here lost both for good: the
 * next attempt hits the idempotent early-return and never reaches them. In a
 * request the callback still rides `after()`; outside one it runs inline.
 */
export async function runAfterOrInline(
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    after(fn);
  } catch {
    await fn();
  }
}
