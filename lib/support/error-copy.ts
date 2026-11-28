/**
 * #support-hub — client-side error presentation.
 *
 * The server's error envelope is `{ error, code, detail? }` where `error` is
 * already user-safe. This mapper prefers CODE-specific copy (richer, action-
 * oriented), falls back to the server's message, and surfaces from `detail`
 * only the schema's per-field messages, which are written for the user.
 */

import { z } from "zod";
import { formatRetryAfter } from "@/lib/labels/auth-errors";

const FieldErrorsDetail = z.object({
  fieldErrors: z.record(z.string(), z.array(z.string()).optional()),
});

const FRIENDLY_COPY: Record<string, string> = {
  UNAUTHORIZED: "Please sign in and try again.",
  INVALID_ID:
    "This session's link looks broken. Open it from your Appointments page and try again.",
  VALIDATION_FAILED:
    "Some details are missing or invalid. Please check and retry.",
  NOT_FOUND: "We couldn't find that anymore — it may have been removed.",
  FORBIDDEN:
    "That option isn't available for your role on this session. You can raise a concern or a billing question about it.",
  RATE_LIMITED:
    "You're doing that a bit too quickly — try again in a few minutes.",
  CONFLICT: "That was just updated somewhere else. Refresh and try again.",
  INTERNAL: "Something went wrong on our side. Please try again in a moment.",
  CASE_DECIDED:
    "This request has a decision, so it can't be reopened. You can appeal the decision instead.",
  REOPEN_WINDOW_EXPIRED:
    "This support case was resolved more than 14 days ago. Start a new support case if you still need help.",
  REOPEN_NOT_ALLOWED: "Only the person who raised this request can reopen it.",
  CASE_ALREADY_DECIDED:
    "This case already has a decision. An admin can supersede it while its appeal window is open.",
  DECISION_NOT_ALLOWED:
    "A problem record is resolved, not decided. Record decisions on its linked incidents.",
  OUTCOME_NOT_ALLOWED: "That outcome doesn't apply to this kind of case.",
  DECISION_SUPERSEDED:
    "That decision was replaced by a newer one. Refresh to see the decision in force.",
  SUPERSEDE_WINDOW_CLOSED:
    "The appeal window for this decision has ended, so it can no longer be superseded.",
  DECISION_APPEALED:
    "This decision has been appealed. Record the outcome on the appeal instead.",
  INVALID_TRANSITION:
    "This request can't move to that status from where it is now. Refresh and try again.",
  OPEN_CASE_EXISTS:
    "There's already an open request about this. Continue in that request instead.",
  REFUND_APPROVED_EXISTS:
    "A refund on this case is approved, pending or sent. Void or reconcile it first.",
  IDEMPOTENCY_KEY_REUSED:
    "This action was already submitted with different details. Refresh and try again.",
};

/** 409s that describe the case itself: retrying or refreshing returns the same answer. */
const DEFINITE_CONFLICTS: ReadonlySet<string> = new Set([
  "OPTION_NOT_AVAILABLE",
  "CASE_DECIDED",
  "REOPEN_WINDOW_EXPIRED",
  "CASE_CLOSED",
  "CASE_ALREADY_DECIDED",
  "DECISION_SUPERSEDED",
  "SUPERSEDE_WINDOW_CLOSED",
  "COMPENSATING_ACTION_REQUIRED",
  "DECISION_APPEALED",
  "INVALID_TRANSITION",
  "OPEN_CASE_EXISTS",
  "IDEMPOTENCY_KEY_REUSED",
  "REFUND_APPROVED_EXISTS",
]);

export interface SupportErrorPayload {
  code?: string;
  error?: string;
  detail?: unknown;
  retryAfterSeconds?: number;
}

/** Parse a failed response into the envelope (never throws on bad JSON). */
export async function readSupportError(
  res: Response,
): Promise<SupportErrorPayload> {
  return res.json().catch(() => ({}));
}

/**
 * User-facing message for a toast. Developer workflow: the caller logs the raw
 * payload (with status) to the console BEFORE calling this.
 */
export function describeSupportError(
  payload: SupportErrorPayload | null,
  fallback = "Something went wrong. Please try again.",
): string {
  const code = payload?.code;
  if (
    code === "RATE_LIMITED" &&
    typeof payload?.retryAfterSeconds === "number" &&
    payload.retryAfterSeconds > 0
  ) {
    return `You're doing that a bit too quickly — try again in ${formatRetryAfter(payload.retryAfterSeconds)}.`;
  }
  if (code && FRIENDLY_COPY[code]) return FRIENDLY_COPY[code];
  // Legacy/unknown paths: the server's `error` is still user-phrased.
  return payload?.error ?? fallback;
}

/** Throw-ready helper for react-query mutationFns: friendly message out,
 *  raw payload to the console for whoever opens devtools. */
export class SupportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    /** First server message per invalid field, for inline display. */
    readonly fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
  /** A refusal the server will repeat verbatim: retrying cannot help. */
  get isDefinite(): boolean {
    return (
      this.status === 403 ||
      this.status === 404 ||
      this.status === 400 ||
      (this.status === 409 && DEFINITE_CONFLICTS.has(this.code ?? ""))
    );
  }
}

/** The first message per field from a Zod `flatten()` detail; empty for any other shape. */
export function fieldErrorsOf(detail: unknown): Record<string, string> {
  const parsed = FieldErrorsDetail.safeParse(detail);
  if (!parsed.success) return {};
  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(parsed.data.fieldErrors)) {
    if (messages?.[0]) out[field] = messages[0];
  }
  return out;
}

/** A write lost its compare-and-set because the case changed underneath it. */
export function isStaleCaseError(e: unknown): boolean {
  return e instanceof SupportRequestError && e.status === 409 && !e.isDefinite;
}

export async function throwSupportError(
  res: Response,
  context: string,
): Promise<never> {
  const payload = await readSupportError(res);
  console.error(`[support] ${context} failed`, res.status, payload);
  throw new SupportRequestError(
    describeSupportError(payload),
    res.status,
    payload.code,
    fieldErrorsOf(payload.detail),
  );
}
