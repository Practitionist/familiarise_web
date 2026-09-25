import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { CronLockHeldError } from "@/lib/cron/cron-lock-errors";
import { RefundValidationError } from "@/lib/payments/operations/refund";
import { IllegalEarningStatusTransitionError } from "@/lib/payments/payouts/earning-status";

/**
 * #1771 K-1 — a refusal an ops door answers with its own code and copy: a
 * state the operator can act on, never a fault, so never a 500 or a Sentry page.
 */
export class OpsRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 409,
  ) {
    super(message);
    this.name = "OpsRefusal";
  }
}

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
