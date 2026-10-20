/**
 * An in-memory world for racing money writers against each other: consultant
 * earnings with their holds, payouts, payments with their disputes and refunds,
 * and wallet accounts. Writers interleave by awaiting the same shared rows, so
 * the only thing standing between them is the predicate each CAS repeats in its
 * `where` clause. A transaction that throws is rolled back to its snapshot.
 */

import { memTable, matchesWhere, type Row, type Where } from "./mem-db";

export type { Row };

export const state = {
  earnings: [] as Row[],
  holds: [] as Row[],
  payouts: [] as Row[],
  payments: [] as Row[],
  disputes: [] as Row[],
  billing: [] as Row[],
};

/** One-shot callbacks that run after a specific read, to land a rival write mid-transaction. */
export const hooks: {
  afterReadyEarningsRead: (() => Promise<void>) | null;
  afterOpenPayoutEarningsRead: (() => Promise<void>) | null;
  afterApprovedPayoutsRead: (() => Promise<void>) | null;
} = {
  afterReadyEarningsRead: null,
  afterOpenPayoutEarningsRead: null,
  afterApprovedPayoutsRead: null,
};

async function runOnce(key: keyof typeof hooks): Promise<void> {
  const hook = hooks[key];
  hooks[key] = null;
  if (hook) await hook();
}

function sum(rows: Row[], key: string): number {
  return rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
}

const earningsBase = memTable(state.earnings, "ce");

export const earningsTable = {
  ...earningsBase,
  findMany: jest.fn(async (args: { where?: Where; select?: Row } = {}) => {
    const rows = await earningsBase.findMany(args);
    if (args.where?.status === "READY" && args.where?.payoutId === null) {
      await runOnce("afterReadyEarningsRead");
    }
    if (args.where?.payout) await runOnce("afterOpenPayoutEarningsRead");
    return rows;
  }),
  groupBy: jest.fn(
    async (args: {
      where?: Where;
      having?: { consultantSharePaise?: { _sum?: { gte?: number } } };
    }) => {
      const matched = state.earnings.filter((r) => matchesWhere(r, args.where));
      const byProfile = new Map<string, Row[]>();
      for (const r of matched) {
        const key = String(r.consultantProfileId);
        byProfile.set(key, [...(byProfile.get(key) ?? []), r]);
      }
      const floor = args.having?.consultantSharePaise?._sum?.gte ?? 0;
      return [...byProfile.entries()]
        .map(([consultantProfileId, rows]) => ({
          consultantProfileId,
          _sum: { consultantSharePaise: sum(rows, "consultantSharePaise") },
        }))
        .filter((g) => g._sum.consultantSharePaise >= floor);
    },
  ),
  aggregate: jest.fn(async (args: { where?: Where }) => {
    const matched = state.earnings.filter((r) => matchesWhere(r, args.where));
    return {
      _sum: {
        consultantSharePaise: sum(matched, "consultantSharePaise"),
        refundedShareAmount: sum(matched, "refundedShareAmount"),
      },
    };
  }),
};

export const holdsTable = memTable(state.holds, "hold");
const payoutsBase = memTable(state.payouts, "po");
export const payoutsTable = {
  ...payoutsBase,
  create: jest.fn(async (args: { data: Row }) =>
    payoutsBase.create({
      data: { retryCount: 0, createdAt: new Date(), ...args.data },
    }),
  ),
  findMany: jest.fn(async (args: { where?: Where } = {}) => {
    const rows = await payoutsBase.findMany(args);
    if (args.where?.status === "APPROVED")
      await runOnce("afterApprovedPayoutsRead");
    return rows.map((r) => ({
      ...r,
      payoutAccount: {
        razorpayFundAccId: "fa_1",
        accountType: "BANK_ACCOUNT",
        isVerified: true,
        payoutsAllowedAfter: null,
        payoutsFrozenAt: null,
      },
      consultantProfile: {
        payoutAccounts: [],
        user: { name: "E", email: "e@x.co" },
      },
    }));
  }),
};

export const paymentsTable = memTable(state.payments, "pay");

export const disputesTable = {
  ...memTable(state.disputes, "dsp"),
  create: jest.fn(async (args: { data: Row }) => {
    const row: Row = { id: `dsp-${state.disputes.length + 1}`, ...args.data };
    state.disputes.push(row);
    const payment = state.payments.find((p) => p.id === row.paymentId);
    if (payment && Array.isArray(payment.disputes)) payment.disputes.push(row);
    return { ...row };
  }),
};

export const billingTable = {
  ...memTable(state.billing, "ba"),
  findUniqueOrThrow: jest.fn(async (args: { where: Where; select?: Row }) => {
    const hit = state.billing.find((r) => matchesWhere(r, args.where));
    if (!hit) throw new Error("No BillingAccount found");
    return { ...hit };
  }),
};

const noop = { updateMany: jest.fn(async () => ({ count: 0 })) };

type Undo = () => void;

/** A table whose writes are journaled so a throwing transaction can undo only its own. */
function journaled<
  T extends {
    updateMany: (args: {
      where?: Where;
      data: Row;
    }) => Promise<{ count: number }>;
    create: (args: { data: Row }) => Promise<Row>;
    createMany: (args: { data: Row[] }) => Promise<{ count: number }>;
  },
>(table: T, rows: Row[], undo: Undo[]): T {
  return {
    ...table,
    updateMany: async (args: { where?: Where; data: Row }) => {
      const hits = rows
        .filter((r) => matchesWhere(r, args.where))
        .map((row) => ({
          row,
          prev: Object.fromEntries(
            Object.keys(args.data).map((k) => [k, row[k]]),
          ),
        }));
      const out = await table.updateMany(args);
      undo.push(() =>
        hits.forEach(({ row, prev }) => Object.assign(row, prev)),
      );
      return out;
    },
    create: async (args: { data: Row }) => {
      const before = new Set(rows);
      const out = await table.create(args);
      undo.push(() => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (!before.has(rows[i])) rows.splice(i, 1);
        }
      });
      return out;
    },
    createMany: async (args: { data: Row[] }) => {
      const before = new Set(rows);
      const out = await table.createMany(args);
      undo.push(() => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (!before.has(rows[i])) rows.splice(i, 1);
        }
      });
      return out;
    },
  };
}

function buildTx(undo: Undo[]) {
  return {
    consultantEarnings: journaled(earningsTable, state.earnings, undo),
    organizationEarnings: memTable([], "oe"),
    earningsHold: journaled(holdsTable, state.holds, undo),
    consultantPayout: journaled(payoutsTable, state.payouts, undo),
    organizationPayout: noop,
    payment: paymentsTable,
    dispute: disputesTable,
    billingAccount: billingTable,
  };
}

/** Commits as it goes; a throw undoes just the writes this transaction made. */
async function transaction<T>(
  fn: (t: ReturnType<typeof buildTx>) => Promise<T>,
): Promise<T> {
  const undo: Undo[] = [];
  try {
    return await fn(buildTx(undo));
  } catch (err) {
    undo.reverse().forEach((u) => u());
    throw err;
  }
}

export const prismaStub = {
  ...buildTx([]),
  $transaction: jest.fn(transaction),
  payoutAccount: {
    findFirst: jest.fn(async () => ({
      id: "pa-1",
      provider: "RAZORPAY",
      accountType: "BANK_ACCOUNT",
      payoutsAllowedAfter: null,
      payoutsFrozenAt: null,
    })),
  },
  consultantProfile: {
    findUnique: jest.fn(async () => ({
      userId: "u-expert",
      msmeStatus: "NONE",
      writtenAgreementWithFamiliarise: false,
    })),
  },
};

export function resetRaceWorld() {
  Object.values(state).forEach((rows) => rows.splice(0, rows.length));
  hooks.afterReadyEarningsRead = null;
  hooks.afterOpenPayoutEarningsRead = null;
  hooks.afterApprovedPayoutsRead = null;
}

/** A payment with the relation arrays the payout gates filter on. */
export function seedPayment(id = "pay-1"): Row {
  const payment: Row = {
    id,
    userId: "u-buyer",
    paymentIntent: `order_${id}`,
    gatewayPaymentId: `gw_${id}`,
    amount: 1_000_000,
    paymentStatus: "SUCCEEDED",
    organizationId: null,
    disputes: [] as Row[],
    refunds: [] as Row[],
  };
  state.payments.push(payment);
  return payment;
}

export function seedEarning(over: Row = {}): Row {
  const payment =
    state.payments.find((p) => p.id === (over.paymentId ?? "pay-1")) ??
    seedPayment(String(over.paymentId ?? "pay-1"));
  const row: Row = {
    id: `ce-${state.earnings.length + 1}`,
    consultantProfileId: "cp-1",
    paymentId: payment.id,
    payment,
    status: "READY",
    payoutId: null,
    consultantSharePaise: 400_000,
    refundedShareAmount: 0,
    preHoldStatus: null,
    holdUntil: null,
    ...over,
  };
  // The payout relation reads live, so a relation filter sees the payout's current status.
  Object.defineProperty(row, "payout", {
    enumerable: true,
    get: () => state.payouts.find((p) => p.id === row.payoutId) ?? null,
  });
  state.earnings.push(row);
  return row;
}
