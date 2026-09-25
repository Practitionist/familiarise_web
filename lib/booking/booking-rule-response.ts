import { NextResponse } from "next/server";

import type { BookingRuleError } from "./booking-rule-error";

/**
 * The route answer for a BookingRuleError; the body carries `code` for the
 * client. Its own module so the scheduling engine (loaded under jsdom in the
 * allocation suites) never imports next/server.
 */
export function bookingRuleResponse(err: BookingRuleError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, errorType: err.code },
    { status: err.httpStatus },
  );
}
