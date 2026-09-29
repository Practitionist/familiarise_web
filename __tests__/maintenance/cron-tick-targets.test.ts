/**
 * @jest-environment node
 */

/**
 * #1633 — the ticker's per-target request shape. `reconcile-ledgers` must be
 * asked to resume (never to open a run), carry no `limit` so the route's own
 * soft deadline bounds the chunk, and get its own 20 s timeout, while the
 * money sweeps keep the six-second default and their `limit`. Jest has no
 * transform for `.mts`, so the function file is transpiled here and its
 * exported `targetRequest` called directly, rather than pinned by grepping
 * source text.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

type TargetRequest = (
  baseUrl: string,
  name: string,
) => { url: string; timeoutMs: number };

function loadTicker(): {
  targetRequest: TargetRequest;
  dueTargets: (now: Date) => string[];
  statusFor: (failed: { name: string; status: number }[]) => number;
  bucketFor: (
    status: number,
    maintenance?: boolean,
  ) => "ok" | "held" | "failed";
} {
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
  const mod = { exports: {} as ReturnType<typeof loadTicker> };
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports });
  return mod.exports;
}

describe("cron-tick targetRequest", () => {
  const { targetRequest } = loadTicker();
  const base = "https://site.test";

  it("resumes the ledger reconcile with no limit and a 20 s timeout", () => {
    expect(targetRequest(base, "reconcile-ledgers")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-ledgers?resume=1",
      timeoutMs: 20_000,
    });
  });

  it("leaves the money sweeps on their limit and the six-second default", () => {
    expect(targetRequest(base, "release-earnings")).toEqual({
      url: "https://site.test/api/cleanup/release-earnings?limit=50",
      timeoutMs: 6_000,
    });
    expect(targetRequest(base, "abandoned-payments")).toEqual({
      url: "https://site.test/api/cleanup/abandoned-payments?limit=10",
      timeoutMs: 6_000,
    });
  });

  // #1583 E-P0-04 — the two booking sweeps with per-row outbox staging or
  // gateway refunds get the 20 s tier; the other three keep the default.
  it("gives the reminders and stale-request sweeps 20 s, the rest 6 s", () => {
    expect(targetRequest(base, "appointment-reminders").timeoutMs).toBe(20_000);
    expect(targetRequest(base, "expire-stale-requests").timeoutMs).toBe(20_000);
    expect(targetRequest(base, "expire-unpaid-trials").timeoutMs).toBe(6_000);
  });

  // #1708 — one Stream round trip per unchanneled row: a bite of ten under a
  // 20 s budget, where fifty under 6 s was aborted on every tick.
  it("gives the orphaned-confirmation reconcile a bite of ten and 20 s", () => {
    expect(targetRequest(base, "reconcile-orphaned-confirmations")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-orphaned-confirmations?limit=10",
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
// 15-minute slot as their siblings (each already has a 30-min Actions twin).
describe("cron-tick dueTargets cadence", () => {
  const { dueTargets } = loadTicker();
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 17, 10, minute));

  it("fires the fifteen-minute sweeps only on a 15-minute slot", () => {
    const off = dueTargets(at(5));
    const on = dueTargets(at(15));
    for (const name of [
      "reconcile-ledgers",
      "sync-payment-earnings",
      "release-earnings",
      "cascade-refund-earnings",
      "reconcile-refunds",
      "abandoned-payments",
      "sweep-stuck-webhook-events",
      "sweep-orphaned-topup-captures",
      "dispatch-outbound-webhooks",
      "retry-failed-emails",
      // #1822 Q-3 — moved off every-tick.
      "reconcile-payment-status",
      "reconcile-orphaned-confirmations",
      // #1583 E-P0-04 — the five booking sweeps ride the 15-minute slots.
      "expire-unpaid-trials",
      "reschedule-proposals",
      "appointment-reminders",
      "tentative-occurrences",
      "expire-stale-requests",
    ]) {
      expect(off).not.toContain(name);
      expect(on).toContain(name);
    }
  });

  it("fires the ticker-only Novu relay every 10 minutes", () => {
    // No Actions twin exists, so 15 would strand bells; 10 halves its burn.
    expect(dueTargets(at(5))).not.toContain("drain-notification-outbox");
    expect(dueTargets(at(10))).toContain("drain-notification-outbox");
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
describe("cron-tick bucketFor", () => {
  const { bucketFor } = loadTicker();

  it("sorts a maintenance 503 with the lock-held 409, a bare 503 as failed", () => {
    expect(bucketFor(503, true)).toBe("held");
    expect(bucketFor(503)).toBe("failed");
    expect(bucketFor(409)).toBe("held");
    expect(bucketFor(200)).toBe("ok");
    expect(bucketFor(500)).toBe("failed");
    expect(bucketFor(0)).toBe("failed");
  });
});
