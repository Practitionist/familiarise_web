// Outcome accounting for the load gate.
//
// A booking storm is not graded by error rate alone. Most requests in a
// hot-slot race are SUPPOSED to fail: exactly one buyer may win a
// consultant-minute and the rest must be turned away. What separates a pass
// from a failure is HOW they are turned away.
//
//   409 / 4xx structured  → PASS. The guard did its job and told the caller so.
//   504 / 502             → FAIL. The request outlived the ~26s function
//                           ceiling, which means a lock or a lock retry budget
//                           is longer than the platform allows (see #1328).
//   5xx other             → FAIL. An unhandled path.
//
// Every counter here is also a k6 threshold source, so the pass/fail verdict is
// the process exit code rather than a human reading a report.

import { Counter, Rate, Trend } from "k6/metrics";

export const winners = new Counter("booking_winners");
export const conflicts = new Counter("booking_conflicts_409");
export const soldOut = new Counter("booking_sold_out");
export const busyRetryable = new Counter("booking_busy_409");
export const serializationConflicts = new Counter("booking_p2034_conflicts");
export const lockUnavailable = new Counter("booking_lock_unavailable_503");
export const rateLimited = new Counter("booking_rate_limited_429");
export const gatewayTimeouts = new Counter("booking_gateway_timeouts_504");
export const serverErrors = new Counter("booking_server_errors_5xx");
export const clientErrors = new Counter("booking_client_errors_4xx");

export const serverErrorRate = new Rate("booking_server_error_rate");
export const timeoutRate = new Rate("booking_timeout_rate");

export const checkoutDuration = new Trend("path_checkout_duration", true);
export const allocateDuration = new Trend("path_allocate_duration", true);
export const cancelDuration = new Trend("path_cancel_duration", true);
export const rescheduleDuration = new Trend("path_reschedule_duration", true);
export const respondDuration = new Trend("path_respond_duration", true);
export const readDuration = new Trend("path_read_duration", true);

/** The structured errorType strings the write routes emit under contention. */
const BUSY_CODES = [
  "EVENT_CHECKOUT_BUSY",
  "CONSULTEE_BOOKING_BUSY",
  "APPOINTMENT_BUSY",
  "BOOKING_BUSY",
];
const SOLD_OUT_CODES = ["EVENT_SOLD_OUT", "EVENT_FULL"];

function errorTypeOf(res) {
  try {
    const body = res.json();
    if (body && typeof body === "object") {
      return body.errorType || body.errorCode || "";
    }
  } catch {
    // A gateway timeout or a platform error answers HTML; the status alone
    // carries the verdict in that case.
  }
  return "";
}

/**
 * Classify one response and feed every counter it belongs to.
 *
 * Returns the verdict string so callers can `check()` on it without re-parsing.
 */
export function record(res) {
  const status = res.status;
  const code = errorTypeOf(res);

  // k6 reports a client-side timeout or a refused connection as status 0.
  // Treat it exactly like a 504: from the buyer's seat it is the same event.
  const timedOut = status === 0 || status === 502 || status === 504;
  timeoutRate.add(timedOut);
  // 503 is deliberately excluded: both lock rails fail CLOSED with a typed 503
  // when Redis is unreachable, which is the designed answer rather than a
  // crash. It gets its own counter and its own threshold so a Redis blip is
  // reported as a Redis blip instead of contaminating the 5xx rate.
  serverErrorRate.add(status >= 500 && status < 600 && status !== 503);

  if (timedOut) {
    gatewayTimeouts.add(1);
    return "timeout";
  }
  if (status >= 200 && status < 300) {
    winners.add(1);
    return "win";
  }
  if (status === 429) {
    rateLimited.add(1);
    clientErrors.add(1);
    return "rate_limited";
  }
  if (status === 503) {
    // Both lock rails fail CLOSED on a Redis outage with a typed 503. It is a
    // correct answer, not a crash, but it means Redis was unreachable.
    lockUnavailable.add(1);
    return "lock_unavailable";
  }
  if (status === 409) {
    conflicts.add(1);
    clientErrors.add(1);
    if (code === "SERIALIZATION_CONFLICT") {
      serializationConflicts.add(1);
      return "p2034";
    }
    if (BUSY_CODES.indexOf(code) !== -1) {
      busyRetryable.add(1);
      return "busy";
    }
    return "conflict";
  }
  if (status >= 400 && status < 500) {
    clientErrors.add(1);
    if (SOLD_OUT_CODES.indexOf(code) !== -1) {
      soldOut.add(1);
      return "sold_out";
    }
    // A losing consultation racer is refused by the slot validator with a 400
    // ("Time slot is already booked"), which is a legitimate loss, not a bug.
    return "rejected";
  }
  serverErrors.add(1);
  return "server_error";
}

/** True when the verdict is an acceptable outcome for a losing racer. */
export function isAcceptableLoss(verdict) {
  return (
    verdict === "conflict" ||
    verdict === "busy" ||
    verdict === "p2034" ||
    verdict === "sold_out" ||
    verdict === "rejected" ||
    verdict === "rate_limited"
  );
}
