/**
 * @jest-environment node
 */

// Invariant: a consultation or trial earning whose session reads LEARNER_ABSENT
// stays PENDING until that verdict is confirmed, on both arms, in the release
// run, its idle probe and a sponsor's trust-park release; a subscription's
// earning releases per tranche and is not held by it.

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
  PAST,
  seedEarnings,
  type EarningsTable as Table,
} from "../fixtures/earnings-release-world";
import { releaseSponsorTrustPark } from "@/lib/payments/payouts/trust-park";
import {
  hasReleasableEarningsWork,
  releaseEarningsFromHold,
} from "@/scripts/earnings/release-earnings";

const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;
const db = () => ({ consultantEarnings, organizationEarnings }) as never;

function seed(
  status: "PENDING" | "PENDING_TRUST",
  opts: { confirmedAt?: Date | null; subscriptionId?: string | null } = {},
) {
  const subscriptionId = opts.subscriptionId ?? null;
  const occurrence: Row = {
    id: "occ_1",
    deletedAt: null,
    isTentative: false,
    completionStatus: "COMPLETED",
    outcome: "LEARNER_ABSENT",
    outcomeConfirmedAt: opts.confirmedAt ?? null,
    hostCancelledAt: null,
    voidedAt: null,
    seatsSettledAt: null,
    meeting: { endedReason: "session_timeout" },
    appointment: { subscriptionId },
  };
  const payment: Row = {
    id: "pay_1",
    amount: 100_000,
    organizationId: "org_sponsor",
    appointmentId: "apt_1",
    refunds: [],
    refundOwedKey: null,
    appointment: { subscriptionId, occurrences: [occurrence] },
  };
  seedEarnings({ consultantEarnings, organizationEarnings }, status, payment);
}

beforeEach(() => jest.clearAllMocks());

it("keeps both arms PENDING while the verdict is unconfirmed", async () => {
  seed("PENDING");
  expect(await hasReleasableEarningsWork(db(), new Date(), () => false)).toBe(
    false,
  );
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 0,
    organizationEarningsReleased: 0,
  });
  expect(consultantEarnings.rows[0].status).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");
});

it("releases both arms once the verdict is confirmed", async () => {
  seed("PENDING", { confirmedAt: PAST });
  expect(await hasReleasableEarningsWork(db(), new Date(), () => false)).toBe(
    true,
  );
  expect(await releaseEarningsFromHold()).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 1,
  });
  expect(consultantEarnings.rows[0].status).toBe("READY");
});

it("does not hold a subscription's earning", async () => {
  seed("PENDING", { subscriptionId: "sub_1" });
  expect(await releaseEarningsFromHold()).toMatchObject({ releasedCount: 1 });
});

it("a sponsor's trust-park release parks an unconfirmed one as PENDING, not READY", async () => {
  seed("PENDING_TRUST");
  expect(
    await releaseSponsorTrustPark(
      { consultantEarnings, organizationEarnings } as never,
      "org_sponsor",
    ),
  ).toMatchObject({ ready: 0, pending: 2 });
});
