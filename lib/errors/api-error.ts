import { NextResponse } from "next/server";

import { classifyError } from "@/lib/errors/classification/payment-error-classification";
import { reportSentryError } from "@/lib/observability/report";
import { setSentryIdentity } from "@/lib/observability/identity";

import { isRefusal, type Refusal } from "./refusal";

interface IApiErrorOptions {
  tag: string; // e.g. "[ClassPlan.GET]"
  error: unknown;
  userId?: string; // for debugging context
  role?: string | null;
  fallbackMessage?: string;
}

/**
 * A `Refusal` answers with its own status and the user's sentence. A 4xx is
 * an answer and never reaches Sentry; only a refusal that chose a 5xx is
 * recorded, and then as an expected `info` event rather than a fault.
 */
function refusalResponse(
  tag: string,
  ctx: string,
  refusal: Refusal,
): NextResponse {
  console.warn(`${tag}${ctx} Refused ${refusal.code}: ${refusal.devMessage}`);
  let errorId: string | undefined;
  if (refusal.httpStatus >= 500) {
    errorId =
      reportSentryError(refusal, {
        subsystem: "api",
        expected: true,
        level: "info",
        tags: { code: refusal.code },
        ...(refusal.context ? { contexts: { refusal: refusal.context } } : {}),
      }) || undefined;
  }
  return NextResponse.json(
    {
      error: refusal.userMessage,
      errorType: refusal.code,
      code: refusal.code,
      ...(errorId ? { errorId } : {}),
    },
    {
      status: refusal.httpStatus,
      ...(errorId ? { headers: { "X-Sentry-Event-Id": errorId } } : {}),
    },
  );
}

export function apiError({
  tag,
  error,
  userId,
  role,
  fallbackMessage,
}: IApiErrorOptions): NextResponse {
  // Many of these routes are reached without going through `requireApiAuth`
  // (or predating it), so the acting user is not always on the isolation
  // scope. This helper already accepted a `userId` and then only interpolated
  // it into a console string — the one place in the codebase where the actor
  // was in hand and got thrown away. Stamp it before either branch reports.
  if (userId) setSentryIdentity({ userId, role });

  // Developer-friendly logging with context
  const ctx = userId ? ` (user: ${userId})` : "";
  if (isRefusal(error)) return refusalResponse(tag, ctx, error);

  const classified = classifyError(error, fallbackMessage);

  let errorId: string | undefined;
  if (classified.isBusinessError) {
    console.warn(`${tag}${ctx} Business rule: ${classified.errorMessage}`);
  } else {
    errorId =
      reportSentryError(error, {
        subsystem: "api",
        tags: { route_tag: tag },
      }) || undefined;
    console.error(`${tag}${ctx} Unexpected:`, error);
  }

  return NextResponse.json(
    {
      error: classified.errorMessage,
      errorType: classified.errorType,
      ...(errorId ? { errorId } : {}),
    },
    {
      status: classified.httpStatus,
      ...(errorId ? { headers: { "X-Sentry-Event-Id": errorId } } : {}),
    },
  );
}
