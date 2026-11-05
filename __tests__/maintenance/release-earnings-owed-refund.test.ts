/**
 * @jest-environment node
 */

// Invariant: an earning whose payment still owes a refund (`refundOwedKey` set)
// is never released, on either arm, by the cohort read, the claim's CAS, the
// ticker's idle probe or a sponsor's trust-park release; clearing the marker
// lifts the hold.

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: jest.fn(
    async (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  const client = {
    consultantEarnings: memTable([], "ce"),
    organizationEarnings: memTable([], "oe"),
  };
  return {
    __esModule: true,
    default: {
      ...client,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
      $disconnect: jest.fn(),
    },
  };
});

import prisma from "@/lib/prisma";
import { matchesWhere, type memTable, type Row } from "../fixtures/mem-db";
import { releaseSponsorTrustPark } from "@/lib/payments/payouts/trust-park";
import {
  hasReleasableEarningsWork,
  RELEASABLE_PAYMENT,
  releaseEarningsFromHold,
} from "@/scripts/earnings/release-earnings";

type Table = ReturnType<typeof memTable>;
const PAST = new Date("2026-06-01T00:00:00.000Z");
const payment: Row = {
  id: "pay_1",
  amount: 100_000,
  organizationId: "org_sponsor",
  appointmentId: null,
  refunds: [],
  refundOwedKey: "plan-end:sub_1:pay:pay_1",
};
const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;
const consultantRows = consultantEarnings.rows;
const orgRows = organizationEarnings.rows;

function seed(status: "PENDING" | "PENDING_TRUST") {
  consultantRows.splice(0, consultantRows.length, {
    id: "ce_1",
    status,
    holdUntil: PAST,
    consultantSharePaise: 80_000,
    consultantProfile: { user: { name: "C", email: "c@x" } },
    payment,
  });
  orgRows.splice(0, orgRows.length, {
    id: "oe_1",
    status,
    holdUntil: PAST,
    orgSharePaise: 10_000,
    organization: { name: "Host org" },
    payment,
  });
}

beforeEach(() => {
  payment.refundOwedKey = "plan-end:sub_1:pay:pay_1";
  jest.clearAllMocks();
});

it("the payment guard requires no owed refund marker", () => {
  expect(RELEASABLE_PAYMENT.refundOwedKey).toBeNull();
  expect(matchesWhere(payment, RELEASABLE_PAYMENT)).toBe(false);
  expect(
    matchesWhere({ ...payment, refundOwedKey: null }, RELEASABLE_PAYMENT),
  ).toBe(true);
});

it("holds both arms past their hold while the marker is set, releases them once it clears", async () => {
  seed("PENDING");
  const now = new Date();

  expect(await hasReleasableEarningsWork(prismaLike(), now, () => false)).toBe(
    false,
  );
  const held = await releaseEarningsFromHold();
  expect(held).toMatchObject({
    releasedCount: 0,
    organizationEarningsReleased: 0,
  });
  expect(consultantRows[0].status).toBe("PENDING");
  expect(orgRows[0].status).toBe("PENDING");
  for (const table of [consultantEarnings, organizationEarnings]) {
    const claim = table.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ payment: { refundOwedKey: null } });
  }

  payment.refundOwedKey = null;
  expect(await hasReleasableEarningsWork(prismaLike(), now, () => false)).toBe(
    true,
  );
  const released = await releaseEarningsFromHold();
  expect(released).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 1,
  });
  expect(consultantRows[0].status).toBe("READY");
  expect(orgRows[0].status).toBe("READY");
});

it("a sponsor's trust-park release parks an owed payment's matured rows as PENDING, not READY", async () => {
  seed("PENDING_TRUST");
  const out = await releaseSponsorTrustPark(
    { consultantEarnings, organizationEarnings } as never,
    "org_sponsor",
  );
  expect(out).toMatchObject({ ready: 0, pending: 2 });
  expect(consultantRows[0].status).toBe("PENDING");
  expect(orgRows[0].status).toBe("PENDING");
});

function prismaLike() {
  return { consultantEarnings, organizationEarnings } as never;
}
