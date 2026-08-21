/**
 * #support-hub — one error envelope for the support surface.
 *
 * Every error response carries:
 *   - `error`: USER-facing copy (safe to toast verbatim)
 *   - `code`:  machine-readable discriminator (client maps richer copy, tests
 *              assert on it, dashboards group by it)
 *   - `detail`: DEVELOPER-facing specifics (zod issues, ids) — echoed in the
 *              payload and attached to the Sentry event
 *
 * Sentry policy: 5xx capture the ORIGINAL exception (full stack) with route
 * context; 4xx capture as warnings so client/server contract drift is visible
 * without paging anyone — except 401/429, which are expected client behavior
 * and would only be noise.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";

export type SupportErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_ID"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "INTERNAL";

/** Default user-facing copy per code — every string safe to show verbatim. */
const USER_COPY: Record<SupportErrorCode, string> = {
  UNAUTHORIZED: "Please sign in to continue.",
  INVALID_ID: "This link looks broken — open the session from your dashboard and try again.",
  VALIDATION_FAILED: "Some details are missing or invalid. Please check and retry.",
  NOT_FOUND: "We couldn't find that anymore — it may have been removed.",
  FORBIDDEN: "You don't have access to this.",
  RATE_LIMITED: "You're doing that a bit too quickly — try again in a few minutes.",
  CONFLICT: "That was just updated somewhere else. Refresh and try again.",
  INTERNAL: "Something went wrong on our side. Please try again in a moment.",
};

export function supportError(opts: {
  status: number;
  code: SupportErrorCode;
  /** Override the default user copy for this code. */
  message?: string;
  /** Developer detail — zod flatten, offending ids, upstream message. */
  detail?: unknown;
  /** Route context bound to the Sentry event (ids, action, role…). */
  context?: Record<string, unknown>;
  /** The ORIGINAL thrown value — preserves the stack in Sentry. */
  cause?: unknown;
}): NextResponse {
  const message = opts.message ?? USER_COPY[opts.code];
  const tags = { subsystem: "support", code: opts.code };
  const extra = { ...opts.context, detail: opts.detail };

  if (opts.cause !== undefined) {
    // Devs first: local runs often have no DSN, so the SDK would swallow it.
    console.error("[support]", opts.context?.route ?? "", opts.cause);
    // An exception happened — capture IT (stack intact), not a re-wrap.
    Sentry.captureException(opts.cause, {
      tags,
      extra,
      level: opts.status >= 500 ? "error" : "warning",
    });
  } else if (opts.status >= 500) {
    Sentry.captureMessage(`[${opts.code}] ${message}`, {
      tags,
      extra,
      level: "error",
    });
  } else if (opts.status !== 401 && opts.status !== 429) {
    // Expected client behavior (auth, throttling) is noise; everything else
    // 4xx is worth seeing as a warning (contract drift, bad deep links).
    Sentry.captureMessage(`[${opts.code}] ${message}`, {
      tags,
      extra,
      level: "warning",
    });
  }

  return NextResponse.json(
    {
      error: message,
      code: opts.code,
      ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    },
    { status: opts.status },
  );
}

/**
 * Parse route params against a schema (e.g. `AppointmentIdParams`), answering
 * with the INVALID_ID envelope on failure. Ids are opaque — the DB lookup is
 * the real validator; this only stops garbage from reaching Prisma. The
 * discriminated union keeps the success path narrow without instanceof.
 */
export async function parseRouteParams<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  context: Record<string, unknown>,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  // Route handlers hand us the `params` PROMISE — awaiting a plain value is a
  // no-op, so both call styles work.
  const parsed = schema.safeParse(await raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: supportError({
        status: 400,
        code: "INVALID_ID",
        detail: parsed.error.flatten(),
        context,
      }),
    };
  }
  return { ok: true, data: parsed.data };
}
