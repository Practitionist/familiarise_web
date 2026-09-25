import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/cron-lock-errors";
import { RefundValidationError } from "@/lib/payments/operations/refund";
import { IllegalEarningStatusTransitionError } from "@/lib/payments/payouts/earning-status";
import { OpsRefusal } from "./ops-refusal-error";

export { OpsRefusal };

const body = (code: string, error: string, status: number) =>
  NextResponse.json({ error, code }, { status });

/** The typed answer for a modelled refusal, or null for a real fault. */
export function refusalResponse(err: unknown): NextResponse | null {
  if (err instanceof OpsRefusal)
    return body(err.code, err.message, err.httpStatus);
  if (err instanceof BookingRuleError)
    return body(err.code, err.message, err.httpStatus);
  if (err instanceof RefundValidationError)
    return body(err.code, err.message, 409);
  if (err instanceof IllegalTransitionError)
    return body(err.code, err.message, err.httpStatus);
  if (err instanceof IllegalEarningStatusTransitionError)
    return body("ILLEGAL_EARNING_TRANSITION", err.message, 409);
  if (err instanceof CronLockHeldError)
    return body("ALREADY_RUNNING", "This job is already running.", 409);
  // #1822 Q-2 — no lock is possible (Redis down): an expected refusal, not a fault.
  if (err instanceof CronLockUnavailableError)
    return body(
      "LOCK_UNAVAILABLE",
      "The job lock is unavailable right now — try again shortly.",
      503,
    );
  if (err instanceof ZodError)
    return body(
      "INVALID_BODY",
      err.issues[0]?.message ?? "Invalid request",
      400,
    );
  return null;
}

/** The code a refusal carries, for the audit row of a door that failed. */
export function refusalCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "FAILED";
}
