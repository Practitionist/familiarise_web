/**
 * @jest-environment node
 */

/**
 * Two invariants about the failed-`SystemEvent`-write report, neither of which
 * is visible from either file alone.
 *
 * 1. The marker `lib/enterprise/system-events.ts` puts on its events must be
 *    the thing `INFRA_TRANSIENT_PATTERNS` in `sentry.shared.config.ts`
 *    recognises. The two are in different modules with no shared constant, so
 *    nothing but a test stops someone rewording one and silently losing the
 *    throttle — which would reintroduce exactly the flood that spent the
 *    2026-09-21 allowance.
 * 2. The throttle must stay NARROW. The obvious alternative implementation is
 *    a database-error pattern, which would also swallow genuine database
 *    faults everywhere else in the app. That is pinned by the negative cases.
 */

import {
  infraThrottleKey,
  INFRA_THROTTLE_MS,
} from "../../sentry.shared.config";
import { SYSTEM_EVENT_WRITE_FAILURE_MARKER } from "../../lib/observability/report";

/** The event shape `beforeSend` actually receives for a thrown Error. */
function thrownEvent(message: string) {
  return {
    exception: { values: [{ type: "Error", value: message }] },
  };
}

describe("failed SystemEvent writes are throttled", () => {
  it("CONFIRMED: the call site's marker is matched by the throttle", () => {
    // Exactly how reportSystemEventWriteFailure builds its message.
    const message = `${SYSTEM_EVENT_WRITE_FAILURE_MARKER}: recordSystemEvent — connection refused`;

    expect(infraThrottleKey(thrownEvent(message))).not.toBeNull();
  });

  it("CONFIRMED: the recordSystemError variant is matched too", () => {
    const message = `${SYSTEM_EVENT_WRITE_FAILURE_MARKER}: recordSystemError — timeout`;

    expect(infraThrottleKey(thrownEvent(message))).not.toBeNull();
  });

  it("gives this failure its OWN class, not a shared one with another pattern", () => {
    const ours = infraThrottleKey(
      thrownEvent(
        `${SYSTEM_EVENT_WRITE_FAILURE_MARKER}: recordSystemEvent — x`,
      ),
    );
    const upstash = infraThrottleKey(
      thrownEvent("max requests limit exceeded"),
    );
    const cronLock = infraThrottleKey(thrownEvent("CronLockUnavailableError"));

    // Separate keys mean separate windows: a SystemEvent-write flood cannot
    // be hidden by an Upstash flood, or vice versa.
    expect(ours).not.toBe(upstash);
    expect(ours).not.toBe(cronLock);
  });
});

describe("the throttle stays narrow", () => {
  it("does NOT swallow an ordinary database fault elsewhere in the app", () => {
    // The regression this scoping exists to prevent. A broad /database|pool/i
    // pattern would make every real data bug in the app invisible.
    for (const message of [
      "Unique constraint failed on the fields: (`email`)",
      "Foreign key constraint failed on the field: `organizationId`",
      "Timed out fetching a new connection from the connection pool",
      "P2028: Transaction API error: Transaction already closed",
    ]) {
      expect(infraThrottleKey(thrownEvent(message))).toBeNull();
    }
  });

  it("does not throttle a normal application error", () => {
    expect(
      infraThrottleKey(thrownEvent("Cannot read properties of undefined")),
    ).toBeNull();
  });

  it("the window is long enough to bound a systemic outage", () => {
    // 10 minutes. The 2026-09-21 flood was ~3,000 events in 24 hours from one
    // dependency; at this window the same shape costs 144/day.
    expect(INFRA_THROTTLE_MS).toBe(10 * 60 * 1000);
  });
});
