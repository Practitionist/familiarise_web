/**
 * Shared Sentry capture helper — every call site in the codebase used to
 * repeat "normalize to Error, stamp subsystem/op/expected tags, pick a level"
 * inline (~80 sites, see PR #1062). Extracted once so that shape lives here.
 */

import * as Sentry from "@sentry/nextjs";
import type { SeverityLevel } from "@sentry/nextjs";
import {
  isExclusionViolation,
  isPoolExhaustion,
  isUniqueViolation,
} from "@/lib/db/pg-errors";

/**
 * Marker that appears in the message of every event reporting a failed
 * `SystemEvent` write. It exists so `INFRA_TRANSIENT_PATTERNS` in
 * `sentry.shared.config.ts` can recognise that ONE call site and trickle it,
 * without a pattern broad enough to also swallow genuine database faults
 * elsewhere in the app.
 *
 * It lives here, in the reporting vocabulary, rather than next to its only
 * reporter: the throttle policy in the Sentry config has to be able to key on
 * it, and importing `lib/enterprise/system-events` to read a string would
 * drag Prisma into the Sentry initialiser. One constant, two readers, so the
 * marker and the pattern cannot drift.
 */
export const SYSTEM_EVENT_WRITE_FAILURE_MARKER = "[system-events] write failed";

export interface ReportOpts {
  subsystem: string;
  op?: string;
  /** true = a modelled outcome (an ANSWER, not a fault). Defaults to false. */
  expected?: boolean;
  /** Overrides the level derived from `expected`. */
  level?: SeverityLevel;
  extra?: Record<string, unknown>;
  /** Merged over the derived subsystem/op/expected tags — can override any of them. */
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
}

function buildSentryCaptureContext(opts: ReportOpts) {
  const expected = opts.expected ?? false;
  // expected:true defaults to "info"; expected:false leaves level unset so
  // Sentry's own default ("error") applies. An explicit opts.level always wins.
  const level = opts.level ?? (expected ? "info" : undefined);
  return {
    tags: {
      subsystem: opts.subsystem,
      ...(opts.op ? { op: opts.op } : {}),
      expected: String(expected),
      ...opts.tags,
    },
    ...(level ? { level } : {}),
    ...(opts.extra ? { extra: opts.extra } : {}),
    ...(opts.contexts ? { contexts: opts.contexts } : {}),
  };
}

// FAMILIARISE_WEB-36: a thrown plain object (Razorpay's `{ statusCode, error }`)
// stringified to "[object Object]"; prefer its own description/message/code.
function normaliseError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const nested = obj.error as Record<string, unknown> | undefined;
    const statusCode = obj.statusCode;
    const detail =
      nested?.description ??
      obj.description ??
      nested?.message ??
      obj.message ??
      nested?.code ??
      obj.code;
    if (typeof detail === "string" || typeof detail === "number") {
      const withStatus =
        statusCode !== undefined
          ? `${detail} (statusCode: ${statusCode})`
          : String(detail);
      return new Error(withStatus);
    }
    try {
      return new Error(JSON.stringify(obj).slice(0, 500));
    } catch {
      return new Error(Object.prototype.toString.call(obj));
    }
  }
  return new Error(String(error));
}

/**
 * #1696 / #1092 — Extract structured Postgres/Prisma error tags (`pool_exhaustion`,
 * `pg_code`, `pg_constraint`) so Sentry alert rules and triage searches can filter
 * on SQLSTATE (`23P01` exclusion overlap, `23505` unique violation, `40001`
 * serialization failure) even when Prisma wraps raw-SQL constraints in
 * `PrismaClientUnknownRequestError`.
 */
function extractPgErrorTags(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isPoolExhaustion(error)) {
    out.pool_exhaustion = "true";
  }
  const msg =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  const metaCode =
    error && typeof error === "object" && "meta" in error
      ? (error as { meta?: { code?: unknown } }).meta?.code
      : undefined;
  const prismaCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (isExclusionViolation(error)) {
    out.pg_code = "23P01";
    if (msg.includes("occurrence_no_confirmed_overlap")) {
      out.pg_constraint = "occurrence_no_confirmed_overlap";
    } else {
      const match = /constraint "([^"]+)"/i.exec(msg);
      if (match?.[1]) out.pg_constraint = match[1];
    }
  } else if (isUniqueViolation(error)) {
    out.pg_code = "23505";
  } else if (
    prismaCode === "P2034" ||
    metaCode === "40001" ||
    msg.includes("40001") ||
    /could not serialize access/i.test(msg)
  ) {
    out.pg_code = "40001";
  } else if (typeof metaCode === "string" && /^[0-9A-Z]{5}$/.test(metaCode)) {
    out.pg_code = metaCode;
  }

  return out;
}

/** Report a caught fault or modelled outcome. Normalises non-Error throws. */
export function reportSentryError(error: unknown, opts: ReportOpts): void {
  const normalised = normaliseError(error);
  const context = buildSentryCaptureContext(opts);
  const pgTags = extractPgErrorTags(error);
  const tags =
    Object.keys(pgTags).length > 0
      ? { ...pgTags, ...context.tags }
      : context.tags;
  Sentry.captureException(normalised, {
    ...context,
    tags,
    extra: { ...(opts.extra ?? {}), thrown: error },
  });
}

/** Sibling of `reportSentryError` for sites with no exception object to attach — idempotency short-circuits, race-losses, malformed-input rejections. */
export function reportSentryMessage(message: string, opts: ReportOpts): void {
  Sentry.captureMessage(message, buildSentryCaptureContext(opts));
}
