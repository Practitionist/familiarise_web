import "server-only";

import * as Sentry from "@sentry/nextjs";

const SLOW_MS = 10_000;
/** Below the platform's ~26 s cut-off, so a request killed mid-read still leaves a line. */
const STALLED_MS = 20_000;

/** Runs a Library read; a slow or stalled one logs once with its duration. */
export async function timedLibraryRead<T>(
  name: string,
  read: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let logged = false;
  const logSlow = () => {
    if (logged) return;
    logged = true;
    const ms = Date.now() - started;
    console.warn(`[Library:SLOW_READ] ${name} ${ms}ms`);
    Sentry.logger.warn(Sentry.logger.fmt`[Library:SLOW_READ] ${name} ${ms}ms`);
  };
  const stalled = setTimeout(logSlow, STALLED_MS);
  try {
    return await read();
  } finally {
    clearTimeout(stalled);
    if (Date.now() - started > SLOW_MS) logSlow();
  }
}
