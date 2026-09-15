import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { classifyError } from "@/lib/errors/classification/payment-error-classification";
import { reportSentryError } from "@/lib/observability/report";

import { isRefusal, type Refusal } from "./refusal";

interface IApiErrorOptions {
  tag: string; // e.g. "[ClassPlan.GET]"
  error: unknown;
  userId?: string; // for debugging context
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
  if (refusal.httpStatus >= 500) {
    reportSentryError(refusal, {
      subsystem: "api",
      expected: true,
      level: "info",
      tags: { code: refusal.code },
      ...(refusal.context ? { contexts: { refusal: refusal.context } } : {}),
    });
  }
  return NextResponse.json(
    {
      error: refusal.userMessage,
      errorType: refusal.code,
      code: refusal.code,
    },
    { status: refusal.httpStatus },
  );
}

export function apiError({
  tag,
  error,
  userId,
  fallbackMessage,
}: IApiErrorOptions): NextResponse {
  // Developer-friendly logging with context
  const ctx = userId ? ` (user: ${userId})` : "";
  if (isRefusal(error)) return refusalResponse(tag, ctx, error);

  const classified = classifyError(error, fallbackMessage);

  if (classified.isBusinessError) {
    console.warn(`${tag}${ctx} Business rule: ${classified.errorMessage}`);
  } else {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "api" } },
    );
    console.error(`${tag}${ctx} Unexpected:`, error);
  }

  return NextResponse.json(
    { error: classified.errorMessage, errorType: classified.errorType },
    { status: classified.httpStatus },
  );
}
