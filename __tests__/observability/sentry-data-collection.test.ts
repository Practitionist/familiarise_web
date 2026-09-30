/**
 * @jest-environment node
 */

/**
 * Guards the data-minimisation policy against the one failure mode that has no
 * other detector.
 *
 * Every other regression in this area announces itself: a build fails, a test
 * fails, a type error appears. This one does not. Measured on 2026-09-29 across
 * 10.59.0, 10.75.3 and 11.1.0 with this repo's exact config, the payload was
 * captured at the transport boundary in each version. Deleting a single key from
 * `SENTRY_DATA_COLLECTION` produces no error, no warning, and no failing test —
 * the SDK resolves that category to its permissive default and keeps sending.
 *
 * Two findings from that experiment are pinned here, because both are silent:
 *
 * 1. **The `queryParams` → `urlQueryParams` rename.** v10's resolver reads
 *    `urlQueryParams ?? queryParams ?? base`, so on 10.x either key works. v11's
 *    reads `urlQueryParams ?? DEFAULTS.urlQueryParams` with NO fallback to the
 *    old name, and the default is `true`. So a v11 upgrade that keeps only the
 *    v10 key silently resumes shipping query strings. The failure is a default,
 *    not an exception, which is why both keys are asserted below.
 *
 * 2. **`Sentry.setUser()` bypasses `dataCollection` entirely.** Sentry's own
 *    documentation states data set explicitly is always sent regardless. So
 *    `userInfo: false` cannot be relied on to withhold the identity this repo
 *    attaches — the call site and the switch in `identity.ts` are the control,
 *    and this test asserts that switch still defaults off.
 */

import {
  INFRA_THROTTLE_MS,
  SENTRY_DATA_COLLECTION,
  infraThrottleKey,
} from "../../sentry.shared.config";
import { isSentryIdentityEnabled } from "../../lib/observability/identity";

describe("the data-minimisation policy", () => {
  /**
   * The complete set. A key missing from this list is a category Sentry will
   * resolve permissively; a key ADDED without thought is a category nobody has
   * decided we send. Both are regressions, and both are silent.
   */
  const REQUIRED_KEYS = [
    "userInfo",
    "cookies",
    "httpHeaders",
    "queryParams",
    "urlQueryParams",
    "httpBodies",
    "stackFrameVariables",
    "genAI",
  ] as const;

  it("has every key the policy depends on, and no others", () => {
    expect(Object.keys(SENTRY_DATA_COLLECTION).sort()).toEqual(
      [...REQUIRED_KEYS].sort(),
    );
  });

  it.each(REQUIRED_KEYS)("keeps %s set", (key) => {
    expect(SENTRY_DATA_COLLECTION).toHaveProperty(key);
  });

  it("keeps BOTH the v10 and v11 spelling of the query-string key", () => {
    // If this test ever fails by removing one, read the comment in
    // sentry.shared.config.ts before "fixing" it. They are not redundant:
    // 10.x reads `urlQueryParams ?? queryParams`, v11 reads `urlQueryParams`
    // with no fallback, and its default is `true`.
    //
    // Read through a widened view on purpose: the config carries the v11 key as a
    // forward-pin and casts to `Record<string, unknown>` to keep it, so the
    // installed SDK's `DataCollection` type cannot see it. Asserting against
    // that type would fail to compile for a key this test exists to protect.
    const collection = SENTRY_DATA_COLLECTION as Record<string, unknown>;
    expect(collection.queryParams).toBe(false);
    expect(collection.urlQueryParams).toBe(false);
  });

  it("collects no identity, cookies, headers or bodies", () => {
    expect(SENTRY_DATA_COLLECTION.userInfo).toBe(false);
    expect(SENTRY_DATA_COLLECTION.cookies).toBe(false);
    expect(SENTRY_DATA_COLLECTION.httpBodies).toEqual([]);
    expect(SENTRY_DATA_COLLECTION.stackFrameVariables).toBe(false);
    expect(SENTRY_DATA_COLLECTION.httpHeaders).toEqual({
      request: false,
      response: false,
    });
  });
});

describe("the identity disclosure, which dataCollection cannot enforce", () => {
  const original = process.env.SENTRY_IDENTITY_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.SENTRY_IDENTITY_ENABLED;
    else process.env.SENTRY_IDENTITY_ENABLED = original;
  });

  it("is off by default, so the state production ships in discloses nothing", () => {
    // The counterpart to the SDK fact above: `userInfo: false` is NOT what stops
    // the cuid. This is.
    delete process.env.SENTRY_IDENTITY_ENABLED;
    expect(isSentryIdentityEnabled()).toBe(false);
  });
});

describe("the quota throttle is still intact", () => {
  it("keeps a ten-minute window", () => {
    expect(INFRA_THROTTLE_MS).toBe(10 * 60 * 1000);
  });

  it("still keys a repeated SystemEvent-write failure to its own class", () => {
    // Asserted here as well as in system-event-write-throttle.test.ts, because
    // this file is the one that runs when someone edits the shared config, and a
    // pattern removed from INFRA_TRANSIENT_PATTERNS is invisible until an audit
    // finds the flood.
    const key = infraThrottleKey({
      exception: {
        values: [
          {
            type: "Error",
            value:
              "[system-events] write failed: recordSystemEvent — timed out",
          },
        ],
      },
    });
    expect(key).not.toBeNull();
  });
});
