import { Prisma } from "@prisma/client";

/**
 * #814/#821 — GitHub Actions runners intermittently fail their FIRST query
 * against the Supabase pooler (observed as PrismaClientKnownRequestError
 * with code 'ETIMEDOUT' on Prisma 7, also seen as P1001/P1002 and
 * PrismaClientInitializationError). Those are transient connectivity
 * failures, not business errors — retry with backoff instead of failing a
 * whole cron run on a cold pooler.
 *
 * Doctrine mirrors lib/db/serializable-retry.ts: ONLY the
 * connectivity-shaped failures retry; everything else (validation errors,
 * business rejections, real query failures) propagates immediately so a
 * broken run is never retried into accidental success.
 */

const CONNECT_ERROR_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // database server reached but timed out
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
]);

const CONNECT_ERROR_MESSAGE =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|Can't reach database server|Timed out fetching a new connection|Connection terminated/i;

export function isDbConnectError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
  }
  if (error instanceof Error && CONNECT_ERROR_MESSAGE.test(error.message)) {
    return true;
  }
  return false;
}

export async function withDbConnectRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 2000;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isDbConnectError(error) || attempt >= attempts) {
        throw error;
      }
      // 2s/4s/8s + jitter — a cold Supabase pooler needs seconds, not ms.
      const backoffMs = baseMs * 2 ** (attempt - 1) + Math.random() * 500;
      console.warn(
        `[connect-retry] transient DB connectivity failure (attempt ${attempt}/${attempts}), retrying in ${Math.round(backoffMs)}ms: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
