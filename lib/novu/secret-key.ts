/**
 * One secret key per Novu environment. Production is the Netlify production
 * context or a GitHub Actions cron twin (both set
 * NEXT_PUBLIC_SENTRY_ENVIRONMENT=production); everything else — previews,
 * branch deploys, a local shell — is Development, so a preview can never
 * page a real user's inbox. Scripts that must target Production say so with
 * `--env production` rather than relying on this detection.
 */
export type NovuEnvironment = "production" | "development";

export function detectNovuEnvironment(): NovuEnvironment {
  const isProduction =
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT === "production" ||
    process.env.CONTEXT === "production";
  return isProduction ? "production" : "development";
}

export function novuSecretKeyName(
  environment: NovuEnvironment,
): "NOVU_PRODUCTION_KEY" | "NOVU_DEVELOPMENT_KEY" {
  return environment === "production"
    ? "NOVU_PRODUCTION_KEY"
    : "NOVU_DEVELOPMENT_KEY";
}

export function resolveNovuSecretKey(
  environment: NovuEnvironment = detectNovuEnvironment(),
): { name: string; key: string | undefined } {
  const name = novuSecretKeyName(environment);
  return { name, key: process.env[name] };
}
