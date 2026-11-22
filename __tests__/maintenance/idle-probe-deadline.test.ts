/** @jest-environment node */
import type { PrismaLike } from "../../lib/prisma";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

type Probe = (
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
) => Promise<boolean>;

jest.mock("../../lib/cron/cleanup-registry", () => {
  const real = (path: string, name: string): Probe =>
    jest.requireActual<Record<string, Probe>>(path)[name];
  return {
    CLEANUP_JOB_BUILDERS: {
      "release-earnings": {
        idle: {
          hasWork: real(
            "../../scripts/earnings/release-earnings",
            "hasReleasableEarningsWork",
          ),
        },
      },
      "auto-complete-appointments": {
        idle: {
          hasWork: real(
            "../../scripts/appointments/auto-complete-appointments",
            "hasAutoCompleteWork",
          ),
        },
      },
      "support-sla-sweep": {
        idle: {
          hasWork: real(
            "../../lib/support/sla-sweep",
            "hasSupportSlaSweepWork",
          ),
        },
      },
    },
  };
});

import {
  IDLE_PROBE_BUDGET_MS,
  IDLE_PROBE_STATEMENT_TIMEOUT_MS,
  probeTick,
} from "../../lib/cron/idle-probe";

const TICK_CLAIM_TIMEOUT_MS = 5_000;
const due = [
  "release-earnings",
  "auto-complete-appointments",
  "support-sla-sweep",
];

let clock = 0;
let starts: { model: string; at: number }[] = [];
let settings: unknown[] = [];
let txOptions: unknown;
let gaugeRows: () => unknown[] = () => [];
let gaugeReads = 0;

/** A fake transaction whose every `findFirst` finds nothing after `costOf(model)` ms of fake time. */
function fakeDb(costOf: (model: string) => number | Error) {
  const tx = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$queryRaw") {
          return async (sql: unknown, ...values: unknown[]) => {
            if (!Array.isArray(sql)) {
              gaugeReads += 1;
              return gaugeRows();
            }
            settings.push(...values);
            return [];
          };
        }
        return {
          findFirst: async () => {
            starts.push({ model, at: clock });
            const cost = costOf(model);
            if (cost instanceof Error) throw cost;
            clock += cost;
            return null;
          },
        };
      },
    },
  );
  return {
    $transaction: async (
      fn: (t: unknown) => Promise<unknown>,
      options: unknown,
    ) => {
      txOptions = options;
      return fn(tx);
    },
  };
}

beforeEach(() => {
  clock = 0;
  starts = [];
  settings = [];
  txOptions = undefined;
  gaugeRows = () => [];
  gaugeReads = 0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const earnings = new Set(["consultantEarnings", "organizationEarnings"]);

describe("idle probe deadline", () => {
  it("starts no statement after the budget and dispatches the unfinished probe", async () => {
    // release-earnings: two 950 ms reads, idle at 1.9 s. auto-complete: 600 ms reads.
    const db = fakeDb((model) => (earnings.has(model) ? 950 : 600));

    const { idle } = await probeTick(due, db as never, new Date());

    expect(idle).toEqual(["release-earnings"]);
    expect(starts.map((s) => s.model)).toEqual([
      "consultantEarnings",
      "organizationEarnings",
      "appointmentOccurrence",
    ]);
    for (const { at } of starts) expect(at).toBeLessThan(IDLE_PROBE_BUDGET_MS);
    expect(clock).toBeLessThanOrEqual(
      IDLE_PROBE_BUDGET_MS + IDLE_PROBE_STATEMENT_TIMEOUT_MS,
    );
    expect(clock).toBeLessThan(TICK_CLAIM_TIMEOUT_MS);
    expect(settings).toEqual([String(IDLE_PROBE_STATEMENT_TIMEOUT_MS)]);
    expect(txOptions).toEqual({
      maxWait: IDLE_PROBE_BUDGET_MS,
      timeout: IDLE_PROBE_BUDGET_MS + IDLE_PROBE_STATEMENT_TIMEOUT_MS,
    });
  });

  it("dispatches a target whose statement Postgres cancelled, keeping earlier idle answers", async () => {
    const cancelled = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    const db = fakeDb((model) =>
      earnings.has(model)
        ? 100
        : model === "appointmentOccurrence"
          ? cancelled
          : 100,
    );

    const { idle } = await probeTick(due, db as never, new Date());

    expect(idle).toEqual(["release-earnings"]);
    // The aborted transaction runs nothing more; support-sla-sweep is dispatched unprobed.
    expect(starts.map((s) => s.model)).not.toContain("supportCase");
  });

  it("marks every probe idle when all finish inside the budget", async () => {
    const db = fakeDb(() => 10);

    const { idle } = await probeTick(due, db as never, new Date());

    expect(idle).toEqual(due);
    expect(clock).toBeLessThan(IDLE_PROBE_BUDGET_MS);
  });
});

describe("pending-age gauges", () => {
  const ages = {
    refundsOwed: 4_000,
    payoutsStuck: 0,
    dunningNotices: 0,
    disputesDue: 0,
    webhookEvents: 120,
    emailRetries: 0,
    notificationRetries: 0,
  };

  it("returns the gauges after every probe finishes", async () => {
    gaugeRows = () => [ages];
    const { idle, pendingAges } = await probeTick(
      due,
      fakeDb(() => 10) as never,
      new Date(),
    );

    expect(idle).toEqual(due);
    // No parked capture: the fake finds no payment.
    expect(pendingAges).toEqual({ ...ages, parkedCaptures: 0 });
  });

  it("keeps the idle answers and reports no gauges when the gauge read fails", async () => {
    gaugeRows = () => {
      throw new Error("gauge query failed");
    };
    const { idle, pendingAges } = await probeTick(
      due,
      fakeDb(() => 10) as never,
      new Date(),
    );

    expect(idle).toEqual(due);
    expect(pendingAges).toBeNull();
  });

  it("skips the gauge read when a probe failed", async () => {
    gaugeRows = () => [ages];
    const db = fakeDb((model) =>
      model === "appointmentOccurrence" ? new Error("probe failed") : 10,
    );
    const { pendingAges } = await probeTick(due, db as never, new Date());

    expect(pendingAges).toBeNull();
    expect(gaugeReads).toBe(0);
  });
});
