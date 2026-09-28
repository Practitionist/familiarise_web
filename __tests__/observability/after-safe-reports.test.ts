/**
 * @jest-environment node
 *
 * `lib/api/after-safe` — the shared `after()` wrapper.
 *
 * The regression pinned here: the wrapper used to `console.error` a rejected
 * task and nothing else, so all 13 of its call sites produced no Sentry event
 * and no `system_events` row on failure. That is not a theoretical gap — the
 * call sites are the payment-success referral bell, the credits-applied bell,
 * the three org invitation/create onboarding emails, the bulk-import tail, the
 * verification decision bells and the scheduling allocation tail, i.e. every
 * post-commit side effect on a money or booking path.
 */

/**
 * `next/server`'s `after` throws outside a request scope, which is how this
 * module's fallback path is reached in practice (scripts, jest, cron twins).
 * Flipped per test rather than mocked out, so both branches stay honest.
 */
let afterThrows = false;

jest.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    if (afterThrows) throw new Error("no request scope");
    void cb();
  },
}));

const reportSentryError = jest.fn();
// Relative specifier, not the `@/` alias: jest.config.ts leaves
// `moduleNameMapper` commented out, and `nextJest` resolves the alias for
// imports but not for the string inside a `jest.mock` factory. This is the
// same idiom `__tests__/lib/client-failure.test.ts` uses.
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
}));

import { scheduleAfter } from "@/lib/api/after-safe";

beforeEach(() => {
  jest.clearAllMocks();
  afterThrows = false;
});

describe("scheduleAfter", () => {
  it("reports a rejected task to Sentry instead of only logging it", async () => {
    const boom = new Error("bell staging failed");
    scheduleAfter(async () => {
      throw boom;
    }, "verification.admin-bells");

    // `after` invokes the task synchronously in the mock above, but the task
    // body is async, so let the microtask queue drain.
    await new Promise((r) => setImmediate(r));

    expect(reportSentryError).toHaveBeenCalledTimes(1);
    const [err, opts] = reportSentryError.mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ];
    expect(err).toBe(boom);
    // Not `expected: true` — that flag means "a modelled outcome, an ANSWER",
    // and a failed side effect is a fault. `beforeSend` re-levels expected
    // events to info, which is where the triage runbook tells a human to stop
    // looking.
    expect(opts).not.toHaveProperty("expected", true);
    expect(opts).toMatchObject({
      subsystem: "after",
      op: "verification.admin-bells",
      level: "warning",
    });
  });

  it("labels an unnamed task rather than leaving the op blank", async () => {
    scheduleAfter(async () => {
      throw new Error("unlabelled");
    });
    await new Promise((r) => setImmediate(r));

    expect(reportSentryError).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "after",
      op: "scheduleAfter",
      level: "warning",
    });
  });

  it("stays quiet when the task succeeds", async () => {
    scheduleAfter(async () => "ok", "checkout.commit-tail");
    await new Promise((r) => setImmediate(r));
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("still reports when `after` throws and the task is run inline", async () => {
    afterThrows = true;
    scheduleAfter(async () => {
      throw new Error("ran outside a request scope");
    }, "org.bulk-import.post-commit");
    await new Promise((r) => setImmediate(r));

    expect(reportSentryError).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "after",
      op: "org.bulk-import.post-commit",
      level: "warning",
    });
  });

  it("does not itself throw when the task rejects outside a request scope", async () => {
    afterThrows = true;
    expect(() =>
      scheduleAfter(async () => {
        throw new Error("x");
      }),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
