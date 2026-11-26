/**
 * @jest-environment node
 */

// Invariant: an earning whose payment still owes a refund (`refundOwedKey` set)
// is never released, on either arm, by the cohort read, the claim's CAS, the
// ticker's idle probe or a sponsor's trust-park release; clearing the marker
// lifts the hold.

jest.mock("../../lib/cron/with-cron-lock", () =>
  jest.requireActual("../fixtures/earnings-release-world").cronLockModule(),
);

jest.mock("../../lib/prisma", () =>
  jest
    .requireActual("../fixtures/earnings-release-world")
    .earningsPrismaModule(),
);

import prisma from "@/lib/prisma";
import { matchesWhere, type Row } from "../fixtures/mem-db";
import {
  seedEarnings,
  type EarningsTable as Table,
} from "../fixtures/earnings-release-world";
import { releaseSponsorTrustPark } from "@/lib/payments/payouts/trust-park";
import {
  hasReleasableEarningsWork,
  RELEASABLE_PAYMENT,
  releaseEarningsFromHold,
} from "@/scripts/earnings/release-earnings";

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
  seedEarnings({ consultantEarnings, organizationEarnings }, status, payment);
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
  const out = await releaseSponsorTrustPark(prisma as never, "org_sponsor");
  expect(out).toMatchObject({ ready: 0, pending: 2 });
  expect(consultantRows[0].status).toBe("PENDING");
  expect(orgRows[0].status).toBe("PENDING");
});

function prismaLike() {
  return { consultantEarnings, organizationEarnings } as never;
}
