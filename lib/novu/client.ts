/**
 * Centralized Novu Client Manager
 * Provides singleton instance for server-side Novu API interactions.
 * Pattern follows lib/stream-client.ts
 */
import { Novu } from "@novu/api";
import { resolveNovuSecretKey } from "./secret-key";

const { name: NOVU_KEY_NAME, key: NOVU_KEY } = resolveNovuSecretKey();

let novuInstance: Novu | null = null;

export function isNovuConfigured(): boolean {
  return !!NOVU_KEY;
}

export function validateNovuConfig(): void {
  if (!NOVU_KEY) {
    throw new Error(
      `${NOVU_KEY_NAME} is not configured. Please set it in your environment variables.`,
    );
  }
}

export function getNovuClient(): Novu {
  validateNovuConfig();

  if (!novuInstance) {
    // #1446 — the SDK defaults to no request timeout and a backoff that keeps
    // retrying connection errors for up to an hour, which is how two triggers
    // ran 39 s each inside an after() callback and starved the instance's only
    // Prisma connection. The caller's deadline stops US waiting; these stop the
    // orphaned request from burning the instance after we have moved on.
    novuInstance = new Novu({
      secretKey: NOVU_KEY!,
      timeoutMs: 5_000,
      retryConfig: {
        strategy: "backoff",
        backoff: {
          initialInterval: 250,
          maxInterval: 1_000,
          exponent: 1.5,
          maxElapsedTime: 5_000,
        },
        retryConnectionErrors: true,
      },
    });
  }

  return novuInstance;
}

export function resetNovuClient(): void {
  novuInstance = null;
}
