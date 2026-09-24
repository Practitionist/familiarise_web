/**
 * @jest-environment node
 */

// #1771 row 6 — the free instant payout: flag gate, the approval cap, once per
// IST day, and a READY row claimed by exactly one of instant and Monday batch.

type Earning = {
  id: string;
  consultantProfileId: string;
  status: string;
  payoutId: string | null;
  consultantSharePaise: number;
  refundedShareAmount: number;
};
type Payout = { id: string; idempotencyKey: string; status: string };

const CP = "cp_1";
const store = { earnings: [] as Earning[], payouts: [] as Payout[] };
const flags = { live: true };
// When set, both transactions read READY rows before either claims them.
let barrier: { arrived: number; open: () => void; gate: Promise<void> } | null =
  null;

const ready = () =>
  store.earnings.filter((e) => e.status === "READY" && e.payoutId === null);
const earning = (id: string, share: number): Earning => ({
  id,
  consultantProfileId: CP,
  status: "READY",
  payoutId: null,
  consultantSharePaise: share,
  refundedShareAmount: 0,
});

function makeTx() {
  const created: Payout[] = [];
  const tx = {
    consultantEarnings: {
      findMany: async () => {
        const rows = ready();
        if (barrier && ++barrier.arrived === 2) barrier.open();
        if (barrier) await barrier.gate;
        return rows;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: { payoutId: string; status: string };
      }) => {
        const hits = ready().filter((e) => where.id.in.includes(e.id));
        hits.forEach((e) => Object.assign(e, data));
        return { count: hits.length };
      },
    },
    consultantPayout: {
      create: async ({ data }: { data: Payout }) => {
        const keys = [...store.payouts, ...created].map(
          (p) => p.idempotencyKey,
        );
        if (keys.includes(data.idempotencyKey)) {
          throw Object.assign(new Error("Unique constraint"), {
            code: "P2002",
          });
        }
        const row = {
          ...data,
          id: `po_${store.payouts.length + created.length}`,
        };
        created.push(row);
        return row;
      },
    },
  };
  return { tx, commit: () => store.payouts.push(...created) };
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantEarnings: {
      aggregate: async () => ({
        _sum: {
          consultantSharePaise: ready().reduce(
            (s, e) => s + e.consultantSharePaise,
            0,
          ),
          refundedShareAmount: 0,
        },
      }),
      groupBy: async () => {
        const sum = ready().reduce((s, e) => s + e.consultantSharePaise, 0);
        return sum
          ? [{ consultantProfileId: CP, _sum: { consultantSharePaise: sum } }]
          : [];
      },
    },
    payoutAccount: {
      findFirst: async () => ({
        id: "pa_1",
        provider: "RAZORPAY",
        accountType: "BANK_ACCOUNT",
        isVerified: true,
      }),
    },
    consultantTaxInfo: { findUnique: async () => null },
    consultantProfile: { findUnique: async () => null },
    consultantPayout: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const { tx, commit } = makeTx();
      const result = await fn(tx);
      commit();
      return result;
    },
  },
}));
jest.mock("../../lib/feature-flags", () => ({
  get ENABLE_LIVE_PAYOUTS() {
    return flags.live;
  },
  ENABLE_TDS_194O_GROSS: false,
}));
// Always granted: the interleave pin models a lost lock, so the CAS count
// check alone must keep a READY row out of two payouts.
jest.mock("../../lib/redis", () => ({
  acquireLock: async () => "tok",
  releaseLock: async () => undefined,
  isMockRedis: () => false,
  checkRedisHealth: async () => true,
  isRedisCircuitOpen: () => false,
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: async () => ({ ok: true }),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutFailed: jest.fn(),
  notifyPayoutProcessed: jest.fn(),
}));

import {
  createInstantPayout,
  createPayoutBatch,
} from "../../lib/payments/payouts/payout-service";

beforeEach(() => {
  store.earnings = [];
  store.payouts = [];
  flags.live = true;
  barrier = null;
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it("refuses with a typed 503 while live payouts are off", async () => {
  flags.live = false;
  store.earnings = [earning("e1", 100_000)];
  await expect(createInstantPayout(CP)).rejects.toMatchObject({
    code: "PAYOUTS_DISABLED",
    httpStatus: 503,
  });
});

it("above the cap the payout waits in the approval queue", async () => {
  store.earnings = [earning("e1", 3_000_000)];
  const outcome = await createInstantPayout(CP);
  expect(outcome.awaitingApproval).toBe(true);
  expect(store.payouts[0]).toMatchObject({
    status: "PENDING",
    kind: "INSTANT",
  });
});

it("a second instant payout the same IST day is a typed 409", async () => {
  const now = new Date("2026-09-25T10:00:00Z");
  store.earnings = [earning("e1", 100_000)];
  await createInstantPayout(CP, now);
  store.earnings.push(earning("e2", 100_000));
  await expect(createInstantPayout(CP, now)).rejects.toMatchObject({
    code: "INSTANT_ALREADY_TODAY",
    httpStatus: 409,
  });
});

it("interleaved with the Monday batch, every READY row is claimed once", async () => {
  store.earnings = [earning("e1", 40_000), earning("e2", 40_000)];
  let open = () => undefined as void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  barrier = { arrived: 0, open: () => open(), gate };

  const outcomes = await Promise.allSettled([
    createPayoutBatch([CP]),
    createInstantPayout(CP),
  ]);

  expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  expect(store.payouts).toHaveLength(1);
  const [winner] = store.payouts;
  expect(store.earnings.every((e) => e.payoutId === winner.id)).toBe(true);
});
