/**
 * @jest-environment node
 */

/**
 * The ticker's per-target request shape, cadence, calendar windows and fleet
 * gate. Schedule helpers are imported from the shared catalog. Jest has no
 * transform for `.mts`, so only the platform adapter is transpiled here.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

import {
  dueTargets,
  targetRequest,
  windowStartFor,
  isFirstDueTickOfHour,
  MAX_TARGETS_PER_TICK,
  type Target,
} from "@/lib/cron/schedule";

import {
  applyErrorBudget,
  resetSentryBudgetState,
} from "../../sentry.shared.config";

type Ticker = Pick<
  typeof import("../../netlify/functions/cron-tick.mjs"),
  | "statusFor"
  | "reportableToSentry"
  | "bucketFor"
  | "buildFailedTargetEvent"
  | "otherActivePlatform"
>;

function loadTicker(): Ticker {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "netlify",
    "functions",
    "cron-tick.mts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = { exports: {} as Ticker };
  vm.runInNewContext(outputText, {
    module: mod,
    exports: mod.exports,
    require,
    process,
    setTimeout,
    clearTimeout,
    AbortController,
  });
  return mod.exports;
}

describe("cron-tick targetRequest", () => {
  const base = "https://site.test";

  it("leaves release-earnings on the fifteen-second default and gives abandoned-payments 20 s", () => {
    expect(targetRequest(base, "release-earnings")).toEqual({
      url: "https://site.test/api/cleanup/release-earnings?limit=50",
      timeoutMs: 15_000,
    });
    expect(targetRequest(base, "abandoned-payments")).toEqual({
      url: "https://site.test/api/cleanup/abandoned-payments?limit=10",
      timeoutMs: 20_000,
    });
  });

  // Booking sweeps with per-row outbox staging or gateway refunds get the 20 s
  // tier; the other two keep the 15 s default.
  it("gives the outbox-staging and refund sweeps 20 s, the rest 15 s", () => {
    expect(targetRequest(base, "appointment-reminders").timeoutMs).toBe(20_000);
    expect(targetRequest(base, "expire-stale-requests").timeoutMs).toBe(20_000);
    expect(targetRequest(base, "reschedule-proposals").timeoutMs).toBe(20_000);
    expect(targetRequest(base, "expire-unpaid-trials").timeoutMs).toBe(15_000);
    expect(targetRequest(base, "tentative-occurrences").timeoutMs).toBe(15_000);
  });

  // #1583 P1 — the five booking sweeps used to be handed `?limit=50` and
  // discard it, because their `run` callbacks took no request. Every one of
  // them is now bounded, and the numbers are asserted rather than trusted:
  // each is far below DEFAULT_LIMIT precisely because the per-row cost is a
  // transaction (and for two of them a gateway round trip), and
  // `expire-stale-requests` is a per-ARM figure across seven arms.
  it("bounds every one of the five booking sweeps with an explicit bite", () => {
    expect(targetRequest(base, "appointment-reminders")).toEqual({
      url: "https://site.test/api/cleanup/appointment-reminders?limit=25",
      timeoutMs: 20_000,
    });
    expect(targetRequest(base, "expire-stale-requests")).toEqual({
      url: "https://site.test/api/cleanup/expire-stale-requests?limit=20",
      timeoutMs: 20_000,
    });
    expect(targetRequest(base, "reschedule-proposals")).toEqual({
      url: "https://site.test/api/cleanup/reschedule-proposals?limit=25",
      timeoutMs: 20_000,
    });
    expect(targetRequest(base, "tentative-occurrences")).toEqual({
      url: "https://site.test/api/cleanup/tentative-occurrences?limit=200",
      timeoutMs: 15_000,
    });
    expect(targetRequest(base, "expire-unpaid-trials")).toEqual({
      url: "https://site.test/api/cleanup/expire-unpaid-trials?limit=25",
      timeoutMs: 15_000,
    });
  });

  // #1775 — the two money-gating session-outcome jobs are ON the ticker. They
  // were not, and the docs recorded that as deliberate ("not
  // latency-sensitive"). The code does not support that: one releases an
  // earnings hold and opens the feedback window once a session's record settles,
  // the other issues a 100% refund, and their only other driver is a `cron:`
  // schedule ADR 22 measured at ~100 minutes. Twenty-five and ten because each
  // candidate costs a Stream call-report round trip.
  it("drives the earnings release and the no-show refund from the ticker", () => {
    expect(targetRequest(base, "auto-complete-appointments")).toEqual({
      url: "https://site.test/api/cleanup/auto-complete-appointments?limit=25",
      timeoutMs: 24_000,
    });
    expect(targetRequest(base, "detect-consultant-no-shows")).toEqual({
      url: "https://site.test/api/cleanup/detect-consultant-no-shows?limit=10",
      timeoutMs: 24_000,
    });
  });

  // #1708 — one Stream round trip per unchanneled row: a bite of ten under a
  // 20 s budget, where fifty under 6 s was aborted on every tick.
  it("gives the orphaned-confirmation reconcile a bite of ten and 20 s", () => {
    expect(targetRequest(base, "reconcile-orphaned-confirmations")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-orphaned-confirmations?limit=10",
      timeoutMs: 20_000,
    });
  });

  it("gives the orphaned-payments alert a bite of ten and 20 s", () => {
    expect(targetRequest(base, "alert-orphaned-payments")).toEqual({
      url: "https://site.test/api/cleanup/alert-orphaned-payments?limit=10",
      timeoutMs: 20_000,
    });
  });

  it("bounds the dispute poll at ten and sends no limit to the ledger audit or the TDS draft", () => {
    expect(targetRequest(base, "reconcile-disputes")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-disputes?limit=10",
      timeoutMs: 20_000,
    });
    expect(targetRequest(base, "reconcile-ledgers")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-ledgers",
      timeoutMs: 20_000,
    });
    expect(targetRequest(base, "tds-return-draft")).toEqual({
      url: "https://site.test/api/cleanup/tds-return-draft",
      timeoutMs: 20_000,
    });
  });

  it("gives the orphaned-payments healer a bite of ten and 20 s", () => {
    expect(targetRequest(base, "reconcile-orphaned-payments")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-orphaned-payments?limit=10",
      timeoutMs: 20_000,
    });
  });
});

// #1686 — six sweeps run on the 15-minute slots only.
// #1792 — Upstash 500k cap: every-tick was cut to only the two
// latency-sensitive money confirms; the rest ride 10/15-minute slots (each
// has an Actions twin at equal or better cadence, except the ticker-only Novu
// relay at 10).
// #1822 Q-3 — the cap was hit again with `reconcile-payment-status` and
// `reconcile-orphaned-confirmations` still every-tick; both now ride the same
// 15-minute cadence as their siblings (each already has a 30-min Actions twin).
// #1926 — phase-stagger 15-minute targets across offsets 0, 5, and 10 so every
// 5-minute tick fires 6–7 targets instead of 19 simultaneous targets at :00/:15/:30/:45.
describe("cron-tick dueTargets cadence", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 17, 10, minute));

  it("staggers fifteen-minute sweeps across offsets 0, 5, and 10 so each fires once per 15 minutes", () => {
    const t0 = dueTargets(at(0));
    const t5 = dueTargets(at(5));
    const t10 = dueTargets(at(10));
    const t15 = dueTargets(at(15));

    const offset0Targets = [
      "sweep-stuck-webhook-events",
      "sweep-orphaned-topup-captures",
      "dispatch-outbound-webhooks",
      "sync-payment-earnings",
      "alert-orphaned-payments",
    ];
    const offset5Targets = [
      "retry-failed-emails",
      "release-earnings",
      "reconcile-refunds",
      "abandoned-payments",
      "reconcile-payment-status",
      "reconcile-orphaned-confirmations",
      "expire-unpaid-trials",
    ];
    const offset10Targets = [
      "reschedule-proposals",
      "appointment-reminders",
      "tentative-occurrences",
      "expire-stale-requests",
      "retry-auto-refunds",
    ];

    for (const name of offset0Targets) {
      expect(t0).toContain(name);
      expect(t15).toContain(name);
      expect(t5).not.toContain(name);
      expect(t10).not.toContain(name);
    }
    for (const name of offset5Targets) {
      expect(t5).toContain(name);
      expect(t0).not.toContain(name);
      expect(t10).not.toContain(name);
    }
    for (const name of offset10Targets) {
      expect(t10).toContain(name);
      expect(t0).not.toContain(name);
      expect(t5).not.toContain(name);
    }
  });

  it("runs confirmed maintenance remediation every fifteen minutes at offset zero", () => {
    for (const minute of [0, 15, 30, 45])
      expect(dueTargets(at(minute))).toContain(
        "maintenance-booking-remediation",
      );
    for (const minute of [5, 10, 20, 25, 35, 40, 50, 55])
      expect(dueTargets(at(minute))).not.toContain(
        "maintenance-booking-remediation",
      );
  });

  it("gives invoice capture recovery six spare slots a day without changing other cadences", () => {
    const name = "reconcile-org-invoice-payments";
    const slots = [];
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      const time = new Date(Date.UTC(2026, 10, 1, 0, minute));
      if (dueTargets(time).includes(name)) slots.push(minute);
    }
    expect(slots).toEqual([235, 475, 715, 955, 1195, 1435]);
    expect(targetRequest("https://site.test", name)).toEqual({
      url: "https://site.test/api/cleanup/reconcile-org-invoice-payments?limit=5",
      timeoutMs: 24_000,
    });
  });

  it("keeps a free slot under MAX_TARGETS_PER_TICK on every tick of 400 days, windows included", () => {
    expect(MAX_TARGETS_PER_TICK).toBe(12);
    // 400 days from 2026-11-01 cover every month start, every weekday and every quarter start.
    const start = Date.UTC(2026, 10, 1);
    let min = Infinity;
    let max = 0;
    for (let m = 0; m < 400 * 24 * 60; m += 5) {
      const n = dueTargets(new Date(start + m * 60_000)).length;
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    expect(min).toBeGreaterThanOrEqual(5);
    expect(max).toBeLessThanOrEqual(MAX_TARGETS_PER_TICK - 1);
  });

  it("fires the orphaned-payments healer only at :10/:40", () => {
    const name = "reconcile-orphaned-payments";
    expect(dueTargets(at(10))).toContain(name);
    expect(dueTargets(at(40))).toContain(name);
    for (const minute of [0, 5, 15, 25, 30]) {
      expect(dueTargets(at(minute))).not.toContain(name);
    }
  });

  it("fires the ticker-only Novu relay every 10 minutes with a 5-minute phase offset", () => {
    // Offset 5 on a 10m cadence fires at :05, :15, :25, :35, :45, :55.
    expect(dueTargets(at(5))).toContain("drain-notification-outbox");
    expect(dueTargets(at(10))).not.toContain("drain-notification-outbox");
    expect(dueTargets(at(15))).toContain("drain-notification-outbox");
  });

  // #1775 — the two session-outcome jobs are 30-minute, not 15. Both are
  // latency-relevant but not minute-relevant: auto-complete's own buffer is one
  // hour after a session ends, and the no-show detector's grace window is
  // measured in tens of minutes, so a 15-minute slot would buy detection
  // latency neither deadline is sensitive to while doubling the Stream
  // call-report volume. The #1792 Upstash budget is the line item.
  // Their phases keep them off the canary's :00 tick and off each other.
  it("fires the earnings release and the no-show refund on staggered 30-minute slots", () => {
    const firing = (name: Target) =>
      [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].filter((minute) =>
        dueTargets(at(minute)).includes(name),
      );
    expect(firing("auto-complete-appointments")).toEqual([15, 45]);
    expect(firing("detect-consultant-no-shows")).toEqual([20, 50]);
  });

  it("fires the Stream control-plane drift check once a day at 01:15 UTC, without a limit", () => {
    const name = "stream-control-plane-drift";
    const firing = Array.from({ length: 24 * 12 }, (_, i) => i * 5).filter(
      (minuteOfDay) =>
        dueTargets(
          new Date(
            Date.UTC(
              2026,
              8,
              17,
              Math.floor(minuteOfDay / 60),
              minuteOfDay % 60,
            ),
          ),
        ).includes(name),
    );

    expect(firing).toEqual([75]);
    expect(targetRequest("https://site.test", name).url).toMatch(
      /\/api\/cleanup\/stream-control-plane-drift$/,
    );
  });

  it("fires the Sentry ingest canary once a day at 00:50 UTC", () => {
    const name = "sentry-ingest-canary";
    const ticks = Array.from({ length: 24 * 12 }, (_, i) => i * 5).filter(
      (minuteOfDay) =>
        dueTargets(
          new Date(
            Date.UTC(
              2026,
              8,
              17,
              Math.floor(minuteOfDay / 60),
              minuteOfDay % 60,
            ),
          ),
        ).includes(name),
    );

    expect(ticks).toEqual([50]);
  });
  it("never reports the Sentry ingest canary's failure TO Sentry", () => {
    /**
     * #1868 — the canary detects that Sentry is discarding events. Reporting
     * that failure to Sentry is the monitor reporting through the failing
     * system: an event per tick that can never arrive, and one more per tick
     * from the allowance it is protecting once ingest recovers.
     *
     * Two things are asserted because both matter and they pull opposite ways:
     * the canary must stay OUT of the Sentry report, and it must stay IN the
     * failed list so a 503 is still visible in the tick's status and body.
     */
    const { reportableToSentry } = loadTicker();

    expect(reportableToSentry("sentry-ingest-canary")).toBe(false);
    expect(reportableToSentry("process-payouts")).toBe(true);
    expect(reportableToSentry("reconcile-ledgers")).toBe(true);
  });
});

// #1686 — Netlify re-invokes a scheduled function that answers 5xx, up to
// three attempts within ~10 s, each re-firing every due target. The failed
// list in the logged body is the operator's signal; the status must stay 200.
describe("cron-tick statusFor", () => {
  const { statusFor } = loadTicker();

  it("answers 200 even when a target failed", () => {
    expect(statusFor([])).toBe(200);
    expect(
      statusFor([
        { name: "reconcile-payment-status", status: 500 },
        { name: "reconcile-orphaned-confirmations", status: 0 },
      ]),
    ).toBe(200);
  });
});

// #1598 P1-W03 — a twin refusing inside a maintenance hold answers 503 with
// a `phase` in the body; that is a healthy hold and joins the 409 bucket. A
// bare 503 (dead route, platform, dependency) stays a failure.
describe("cron-tick reportableToSentry", () => {
  const { reportableToSentry, bucketFor } = loadTicker();

  it("excludes the canary from the Sentry report but keeps it in the failed list", () => {
    /**
     * #1868 — the canary detects that Sentry is discarding events, so
     * reporting that failure to Sentry is the monitor reporting through the
     * failing system. The two halves matter and pull opposite ways: out of the
     * Sentry report, still in the tick's own status and body.
     */
    expect(reportableToSentry("sentry-ingest-canary")).toBe(false);
    expect(reportableToSentry("process-payouts")).toBe(true);
    expect(reportableToSentry("reconcile-ledgers")).toBe(true);

    // Suppression is of the Sentry report only, never of the tick's visibility.
    expect(bucketFor(503)).toBe("failed");
  });
});

describe("cron-tick bucketFor", () => {
  const { bucketFor } = loadTicker();

  it("sorts a maintenance 503 with the lock-held 409, a bare 503 and a money-batch 207 as failed", () => {
    expect(bucketFor(503, true)).toBe("held");
    expect(bucketFor(503)).toBe("failed");
    expect(bucketFor(409)).toBe("held");
    expect(bucketFor(200)).toBe("ok");
    expect(bucketFor(207, false, "process-payouts")).toBe("failed");
    expect(bucketFor(207, false, "dunning")).toBe("failed");
    expect(bucketFor(207, false, "sweep-orphaned-topup-captures")).toBe(
      "failed",
    );
    expect(bucketFor(207, false, "reconcile-payment-status")).toBe("ok");
    expect(bucketFor(500)).toBe("failed");
    expect(bucketFor(0)).toBe("failed");
  });
});

describe("cron-tick calendar windows", () => {
  const utc = (d: number, h: number, m: number) =>
    new Date(Date.UTC(2026, 10, d, h, m));

  it("fires the weekly payout batch on its Monday 20:00 window only", () => {
    // 2026-11-02 is a Monday.
    expect(dueTargets(utc(2, 20, 5))).toContain("create-payout-batch");
    expect(dueTargets(utc(2, 22, 50))).toContain("create-payout-batch");
    expect(dueTargets(utc(2, 23, 5))).not.toContain("create-payout-batch");
    expect(dueTargets(utc(3, 20, 5))).not.toContain("create-payout-batch");
    expect(
      windowStartFor("create-payout-batch", utc(2, 21, 35))?.toISOString(),
    ).toBe("2026-11-02T20:00:00.000Z");
  });

  it("anchors a window that runs past midnight to the day it opened", () => {
    expect(dueTargets(utc(3, 0, 10))).toContain("dunning");
    expect(windowStartFor("dunning", utc(3, 0, 40))?.toISOString()).toBe(
      "2026-11-02T23:30:00.000Z",
    );
    expect(dueTargets(utc(3, 2, 40))).not.toContain("dunning");
  });

  it("opens the monthly rollup on the 1st only and sends the window start", () => {
    expect(dueTargets(utc(1, 4, 45))).toContain("settle-invoice-accruals");
    expect(dueTargets(utc(2, 4, 45))).not.toContain("settle-invoice-accruals");
    expect(
      targetRequest(
        "https://site.test",
        "settle-invoice-accruals",
        utc(1, 5, 45),
      ).url,
    ).toBe(
      "https://site.test/api/cleanup/settle-invoice-accruals?limit=10&windowStart=2026-11-01T04:00:00.000Z",
    );
  });

  it("alternates the two payout reconcilers on :40, each every two hours", () => {
    const fires = (name: Parameters<typeof windowStartFor>[0]) =>
      Array.from({ length: 24 * 12 }, (_, i) => utc(4, 0, i * 5))
        .filter((t) => dueTargets(t).includes(name))
        .map((t) => t.toISOString().slice(11, 16));
    const stuck = fires("handle-stuck-payouts");
    const status = fires("reconcile-payout-status");
    expect(stuck).toHaveLength(12);
    expect(status).toHaveLength(12);
    expect(stuck.slice(0, 2)).toEqual(["00:40", "02:40"]);
    expect(status.slice(0, 2)).toEqual(["01:40", "03:40"]);
    expect(targetRequest("https://site.test", "handle-stuck-payouts")).toEqual({
      url: "https://site.test/api/cleanup/handle-stuck-payouts?limit=5",
      timeoutMs: 24_000,
    });
    expect(
      targetRequest("https://site.test", "reconcile-payout-status").url,
    ).toBe("https://site.test/api/cleanup/reconcile-payout-status?limit=8");
  });

  it("runs the GST register hourly on the 2nd only, 04:45 to 22:45", () => {
    const fires = (day: number) =>
      Array.from({ length: 24 * 12 }, (_, i) => utc(day, 0, i * 5))
        .filter((t) => dueTargets(t).includes("gst-outward-register-export"))
        .map((t) => t.toISOString().slice(11, 16));
    const second = fires(2);
    expect(second).toHaveLength(19);
    expect([second[0], second[18]]).toEqual(["04:45", "22:45"]);
    expect(fires(1)).toEqual([]);
    expect(fires(3)).toEqual([]);
    expect(
      targetRequest(
        "https://site.test",
        "gst-outward-register-export",
        utc(2, 4, 45),
      ),
    ).toEqual({
      url: "https://site.test/api/cleanup/gst-outward-register-export?limit=25&windowStart=2026-11-02T04:00:00.000Z",
      timeoutMs: 24_000,
    });
  });

  it("runs hourly ledger slices where statutory and settlement jobs leave capacity", () => {
    const fires = (name: Parameters<typeof windowStartFor>[0]) =>
      Array.from({ length: 24 * 12 }, (_, i) => utc(4, 0, i * 5)).filter((t) =>
        dueTargets(t).includes(name),
      );
    const disputes = fires("reconcile-disputes");
    expect(disputes).toHaveLength(24);
    expect(disputes.every((t) => t.getUTCMinutes() === 0)).toBe(true);
    const ledgers = fires("reconcile-ledgers");
    expect(ledgers.length).toBeGreaterThan(12);
    expect(ledgers.every((t) => t.getUTCMinutes() === 55)).toBe(true);
    expect(ledgers.some((t) => t.getUTCHours() === 23)).toBe(true);
    // A busy settlement tick still keeps the ledger slice.
    const busy = dueTargets(utc(4, 6, 55));
    expect(busy).toContain("reconcile-gateway-settlements");
    expect(busy).toContain("reconcile-ledgers");
    expect(busy.length).toBeLessThanOrEqual(MAX_TARGETS_PER_TICK);
  });

  it("runs the TDS draft only on the 5th of January, April, July and October", () => {
    const fires = (month: number, day: number) =>
      Array.from(
        { length: 24 * 12 },
        (_, i) => new Date(Date.UTC(2027, month, day, 0, i * 5)),
      ).filter((t) => dueTargets(t).includes("tds-return-draft"));
    expect(fires(0, 5).map((t) => t.toISOString())).toEqual([
      "2027-01-05T01:55:00.000Z",
      "2027-01-05T02:55:00.000Z",
    ]);
    expect(fires(3, 5)).toHaveLength(2);
    expect(fires(1, 5)).toHaveLength(0);
    expect(fires(0, 6)).toHaveLength(0);
  });

  it("sends the MSME digest once a day and payouts every hour", () => {
    const fires = (name: Parameters<typeof windowStartFor>[0]) =>
      Array.from({ length: 24 * 12 }, (_, i) => utc(4, 0, i * 5)).filter((t) =>
        dueTargets(t).includes(name),
      ).length;
    expect(fires("msme-payment-alerts")).toBe(1);
    expect(fires("process-payouts")).toBe(24);
  });
});

describe("cron-tick failed-target reporting", () => {
  const { buildFailedTargetEvent } = loadTicker();

  beforeEach(() => {
    resetSentryBudgetState();
    jest.useFakeTimers().setSystemTime(new Date("2026-10-04T00:00:00Z"));
  });
  afterEach(() => jest.useRealTimers());

  it("names the target in the message and fingerprint", () => {
    const ev = buildFailedTargetEvent({
      name: "sweep-stuck-webhook-events",
      status: 0,
    });
    expect(ev.message).toBe(
      "cron-tick: target sweep-stuck-webhook-events failed",
    );
    expect(ev.fingerprint).toEqual(["cron-tick", "sweep-stuck-webhook-events"]);
    expect(ev.level).toBe("error");
    expect(ev.contexts.tick).toEqual({
      target: "sweep-stuck-webhook-events",
      status: 0,
      outcome: "network",
    });
    expect(
      buildFailedTargetEvent({
        name: "release-earnings",
        status: 500,
        errorBody: "Internal Server Error - Request ID: abc",
      }).tags,
    ).toMatchObject({ target: "release-earnings", class: "platform" });
  });

  it("the shared repeat filter throttles per target, not across targets", () => {
    const a = buildFailedTargetEvent({
      name: "reconcile-refunds",
      status: 500,
    });
    const b = buildFailedTargetEvent({ name: "release-earnings", status: 503 });
    expect(applyErrorBudget({ ...a })).not.toBeNull();
    expect(applyErrorBudget({ ...b })).not.toBeNull();
    expect(applyErrorBudget({ ...a })).toBeNull();
  });
});

describe("cron-tick drain targets and failure reporting", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 4, 12, m, 0));

  it("runs process-data-exports every 10 minutes and retry-moderation-enforcement every 30", () => {
    const exportsMinutes = [
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ].filter((m) => dueTargets(at(m)).includes("process-data-exports"));
    expect(exportsMinutes).toEqual([0, 10, 20, 30, 40, 50]);
    const moderationMinutes = [
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ].filter((m) => dueTargets(at(m)).includes("retry-moderation-enforcement"));
    expect(moderationMinutes).toEqual([25, 55]);
  });

  it("lets each target report once an hour, on its own first due tick", () => {
    const reportMinutes = (name: string) =>
      [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].filter((m) =>
        isFirstDueTickOfHour(name, at(m)),
      );
    expect(reportMinutes("sweep-stuck-webhook-events")).toEqual([0]);
    expect(reportMinutes("release-earnings")).toEqual([5]);
    expect(reportMinutes("retry-moderation-enforcement")).toEqual([25]);
    expect(reportMinutes("reconcile-payout-status")).toEqual([40]);
    expect(reportMinutes("sentry-ingest-canary")).toEqual([50]);
  });
});

describe("cron-tick fleet gate (ops:active_cron_platform)", () => {
  const { otherActivePlatform } = loadTicker();
  const env = {
    UPSTASH_REDIS_REST_URL: "https://redis.test/",
    UPSTASH_REDIS_REST_TOKEN: "tok",
  };
  const replying = (body: unknown, status = 200) =>
    jest.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    );

  it("runs when the key is absent", async () => {
    const fetchImpl = replying({ result: null });
    await expect(otherActivePlatform(env, fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://redis.test/get/ops%3Aactive_cron_platform",
    );
  });

  it("runs when the key says netlify", async () => {
    await expect(
      otherActivePlatform(env, replying({ result: "netlify" })),
    ).resolves.toBeNull();
  });

  it("skips and names the platform when the key says another host", async () => {
    await expect(
      otherActivePlatform(env, replying({ result: "vercel" })),
    ).resolves.toBe("vercel");
  });

  it("fails open on a fetch error, an error status, a malformed reply and missing credentials", async () => {
    const rejecting = jest.fn(async () => {
      throw new Error("network down");
    });
    await expect(otherActivePlatform(env, rejecting)).resolves.toBeNull();
    await expect(
      otherActivePlatform(env, replying({ error: "ERR" }, 500)),
    ).resolves.toBeNull();
    await expect(
      otherActivePlatform(env, replying({ result: 7 })),
    ).resolves.toBeNull();
    const unused = replying({ result: "vercel" });
    await expect(otherActivePlatform({}, unused)).resolves.toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
});
