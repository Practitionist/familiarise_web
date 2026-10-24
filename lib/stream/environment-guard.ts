/**
 * The production Stream app serves production traffic only; every other
 * deployment uses the separate Familiarise-dev app. Pure and import-safe: the
 * check runs when a client is first used, never at module load or build time.
 */

/** The production app's API key. Public by design (shipped as NEXT_PUBLIC_STREAM_API_KEY). */
export const PRODUCTION_STREAM_API_KEY = "k4n5crxtstrx";

export interface StreamClientOptions {
  /** Owner CLIs run with `--target=production` set this; nothing else may. */
  allowProductionKeyOutsideProduction?: boolean;
}

export class StreamEnvironmentError extends Error {
  constructor() {
    super(
      "The production Stream API key is configured outside a production deployment; use the Familiarise-dev app's keys here.",
    );
    this.name = "StreamEnvironmentError";
  }
}

/**
 * Netlify decides by `CONTEXT`, Vercel by `VERCEL_ENV`; any other runtime
 * (container host, GitHub Actions cron twin) is production only when
 * `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is "production", the marker Novu key
 * selection already trusts. A Netlify runtime without `CONTEXT` uses that marker too.
 */
export function isProductionDeployment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NETLIFY === "true" && env.CONTEXT) {
    return env.CONTEXT === "production";
  }
  if (env.VERCEL === "1") {
    return env.VERCEL_ENV === "production";
  }
  return env.NEXT_PUBLIC_SENTRY_ENVIRONMENT === "production";
}

export function assertStreamKeyAllowedHere(
  apiKey: string | undefined,
  options?: StreamClientOptions,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (apiKey !== PRODUCTION_STREAM_API_KEY) return;
  if (options?.allowProductionKeyOutsideProduction) return;
  if (isProductionDeployment(env)) return;
  throw new StreamEnvironmentError();
}
