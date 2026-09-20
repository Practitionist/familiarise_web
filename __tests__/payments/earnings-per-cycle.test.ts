/**
 * @jest-environment node
 */

/**
 * #1766 — a subscription's earnings are delivery-enforced escrow: ONE PENDING
 * tranche per cycle, `holdUntil` NULL until the cycle's last session
 * completes. The rows must sum to the fee and the pool exactly, with every
 * floored paisa on tranche 0, or EARNINGS_LEDGER_DRIFT fires against the
 * one booking journal the accrual still posts.
 */

const PAYMENT_ID = "pay-sub-1";
const APPOINTMENT_ID = "appt-sub-1";
const PROFILE_ID = "cp-1";

jest.mock("../../lib/feature-flags", () => ({ ENABLE_HOST_ORGS: false }));
// Collaborator splits are webinar/class only; the module drags Stream and
// Better Auth in through its imports, so it is stubbed like the sibling suites.
jest.mock("../../lib/collaborators/service", () => ({
  calculateRevenueSplit: jest.fn(),
}));
jest.mock("../../lib/api/organizations/rate-card", () => ({
  resolveEffectiveRateCard: jest.fn(),
  isScopedRateCardResolutionEnabled: () => false,
}));

type EarningsCreate = {
  grossAmount: number;
  platformFeePaise: number;
  consultantSharePaise: number;
  cycleOrdinal: number | null;
  holdUntil: Date | null;
  status: string;
};

let created: EarningsCreate[] = [];
let subscriptionRow: unknown = null;

jest.mock("../../lib/prisma", () => {
  const tx = {
    consultantEarnings: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: EarningsCreate }) => {
        created.push(data);
        return { id: `earn-${created.length}`, ...data };
      }),
      // Tranche 0 is created alone (its id is the owner id); the rest land in
      // one createMany.
      createMany: jest.fn(async ({ data }: { data: EarningsCreate[] }) => {
        created.push(...data);
        return { count: data.length };
      }),
    },
    appointment: {
      findUnique: jest.fn(async () => ({ subscription: subscriptionRow })),
    },
    membership: { findFirst: jest.fn().mockResolvedValue(null) },
    paymentLeg: { findMany: jest.fn().mockResolvedValue([]) },
    overageEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "ltxn-1" }),
    },
    ledgerAccount: {
      upsert: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    ledgerAccountBalance: { upsert: jest.fn().mockResolvedValue({}) },
  };
  return {
    __esModule: true,
    default: {
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
      appointmentOccurrence: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };
});

import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";

function payment(originalAmount: number) {
  return {
    id: PAYMENT_ID,
    amount: Math.round(originalAmount * 1.18),
    originalAmount,
    taxAmount: Math.round(originalAmount * 0.18),
    appointmentId: APPOINTMENT_ID,
    organizationId: null,
    billingAccountId: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    appointment: { consultantProfile: { id: PROFILE_ID } },
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]["payment"];
}

beforeEach(() => {
  created = [];
  subscriptionRow = null;
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

it("10 sessions at 3 per week → 4 tranches summing exactly to the fee and the pool, residual on 0", async () => {
  subscriptionRow = {
    sessionsTotal: 10,
    subscriptionPlan: {
      totalSessions: 10,
      sessionsPerWeek: 3,
      durationInMonths: 1,
    },
  };
  // An amount that does not divide: 20% fee = 20 001, pool = 80 004.
  const gross = 100_005;

  const ownerId = await createEarningsFromPayment({
    payment: payment(gross),
    appointmentType: "SUBSCRIPTION",
  });

  expect(ownerId).toBe("earn-1");
  expect(created.map((r) => r.cycleOrdinal)).toEqual([0, 1, 2, 3]);
  expect(created.every((r) => r.holdUntil === null)).toBe(true);
  expect(created.every((r) => r.status === "PENDING")).toBe(true);

  const fee = Math.floor((gross * 20) / 100);
  const pool = gross - fee;
  const sum = (k: keyof EarningsCreate) =>
    created.reduce((s, r) => s + (r[k] as number), 0);
  expect(sum("platformFeePaise")).toBe(fee);
  expect(sum("consultantSharePaise")).toBe(pool);
  expect(sum("grossAmount")).toBe(gross);

  // Tranches 1 and 2 hold 3 sessions, tranche 3 holds the short tail of 1;
  // tranche 0 is 3 sessions plus the floored remainder.
  expect(created[1].consultantSharePaise).toBe(Math.floor((pool * 3) / 10));
  expect(created[3].consultantSharePaise).toBe(Math.floor((pool * 1) / 10));
  expect(created[0].consultantSharePaise).toBeGreaterThanOrEqual(
    created[1].consultantSharePaise,
  );
});

it("a non-subscription payment keeps its single row with a stamped hold and no ordinal", async () => {
  await createEarningsFromPayment({
    payment: payment(50_000),
    appointmentType: "CONSULTATION",
  });

  expect(created).toHaveLength(1);
  expect(created[0].cycleOrdinal).toBeUndefined();
  expect(created[0].holdUntil).toBeInstanceOf(Date);
});
