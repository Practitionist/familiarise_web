/**
 * @jest-environment node
 */

// Invariant: an earning whose payment has an active dispute is never released,
// on either arm, by the cohort read, the claim's CAS, the ticker's idle probe
// or a sponsor's trust-park release, whenever the earning was written; a
// decided dispute lifts the gate.

jest.mock("../../lib/cron/with-cron-lock", () =>
  jest.requireActual("../fixtures/earnings-release-world").cronLockModule(),
);

jest.mock("../../lib/prisma", () =>
  jest
    .requireActual("../fixtures/earnings-release-world")
    .earningsPrismaModule(),
);

import prisma from "@/lib/prisma";
import type { Row } from "../fixtures/mem-db";
import {
  seedEarnings,
  type EarningsTable as Table,
} from "../fixtures/earnings-release-world";
import { releaseSponsorTrustPark } from "@/lib/payments/payouts/trust-park";
import {
  hasReleasableEarningsWork,
  releaseEarningsFromHold,
} from "@/scripts/earnings/release-earnings";

const dispute: Row = { status: "NEEDS_RESPONSE" };
const payment: Row = {
  id: "pay_1",
  amount: 100_000,
  organizationId: "org_sponsor",
  appointmentId: null,
  refunds: [],
  refundOwedKey: null,
  disputes: [dispute],
};
const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;
const tables = { consultantEarnings, organizationEarnings };

beforeEach(() => {
  dispute.status = "NEEDS_RESPONSE";
  jest.clearAllMocks();
});

it("holds both arms past their hold while the dispute is active, releases them once it is decided", async () => {
  seedEarnings(tables, "PENDING", payment);
  const now = new Date();

  expect(
    await hasReleasableEarningsWork(tables as never, now, () => false),
  ).toBe(false);
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 0,
    organizationEarningsReleased: 0,
  });
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");

  dispute.status = "WON";
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 1,
  });
});

it("the claim restates the dispute gate", async () => {
  seedEarnings(tables, "PENDING", payment);
  // The cohort read saw no dispute; one opened before the claim.
  dispute.status = "WON";
  consultantEarnings.findMany.mockImplementationOnce(async () => {
    dispute.status = "NEEDS_RESPONSE";
    return [{ ...consultantEarnings.rows[0] }];
  });

  const out = await releaseEarningsFromHold();

  expect(out.releasedCount).toBe(0);
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
});

it("a sponsor's trust-park release parks a disputed payment's matured rows as PENDING, not READY", async () => {
  seedEarnings(tables, "PENDING_TRUST", payment);
  const out = await releaseSponsorTrustPark(prisma as never, "org_sponsor");
  expect(out).toMatchObject({ ready: 0, pending: 2 });
});
