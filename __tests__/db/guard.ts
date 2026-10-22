/** The database tier may only ever touch the CI job's disposable Postgres. */
const DISPOSABLE_HOSTS = ["localhost", "127.0.0.1"];

export function assertDisposableDatabase(
  env: NodeJS.ProcessEnv = process.env,
): void {
  let target: URL | null = null;
  try {
    target = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
  } catch {
    target = null;
  }
  if (
    env.CI !== "true" ||
    !target ||
    !DISPOSABLE_HOSTS.includes(target.hostname) ||
    target.pathname !== "/ci"
  )
    throw new Error(
      "The database tier runs only in CI against the disposable localhost /ci Postgres (CI=true and DATABASE_URL on localhost with database ci).",
    );
}

// Jest globalSetup: runs once, after next/jest has loaded .env and before any test connects.
export default function globalSetup(): void {
  assertDisposableDatabase();
}
