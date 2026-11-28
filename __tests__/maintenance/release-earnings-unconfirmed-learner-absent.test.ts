/**
 * @jest-environment node
 */

// Invariant: an earning whose booking has a session reading LEARNER_ABSENT stays
// PENDING until that verdict is confirmed, on both arms, in the release run, its
// idle probe and a sponsor's trust-park release. A plan is held whole: every
// dated tranche and the host organisation's earning wait for the one verdict.

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

describe("a plan with two dated tranches and one learner-absent session", () => {
  /** Cycle 0 held weeks ago; cycle 1 holds the learner-absent session, in `absent`'s state. */
  function seedPlan(absent: Row, cycleOneHoldUntil: Date | null = PAST) {
    const session = (id: string, over: Row = {}): Row => ({
      id,
      deletedAt: null,
      isTentative: false,
      completionStatus: "COMPLETED",
      outcome: "HELD",
      outcomeConfirmedAt: null,
      hostCancelledAt: null,
      voidedAt: null,
      seatsSettledAt: null,
      meeting: { endedReason: "session_timeout" },
      appointment: { subscriptionId: "sub_1" },
      ...over,
    });
    const payment: Row = {
      id: "pay_plan",
      amount: 400_000,
      organizationId: null,
      appointmentId: "apt_plan",
      refunds: [],
      refundOwedKey: null,
      appointment: {
        subscriptionId: "sub_1",
        occurrences: [
          session("c0_s1"),
          session("c0_s2"),
          session("c1_s1"),
          session("c1_s2", absent),
        ],
      },
    };
    const tranche = (cycleOrdinal: number, holdUntil: Date | null): Row => ({
      id: `ce_cycle_${cycleOrdinal}`,
      status: "PENDING",
      cycleOrdinal,
      holdUntil,
      consultantSharePaise: 80_000,
      consultantProfile: { user: { name: "C", email: "c@x" } },
      payment,
    });
    consultantEarnings.rows.splice(
      0,
      consultantEarnings.rows.length,
      tranche(0, PAST),
      tranche(1, cycleOneHoldUntil),
    );
    organizationEarnings.rows.splice(0, organizationEarnings.rows.length, {
      id: "oe_plan",
      status: "PENDING",
      holdUntil: PAST,
      orgSharePaise: 10_000,
      organization: { name: "Host org" },
      payment,
    });
  }
  const statuses = () =>
    Object.fromEntries(
      [...consultantEarnings.rows, ...organizationEarnings.rows].map((r) => [
        r.id,
        r.status,
      ]),
    );

  it("releases neither tranche nor the host organisation's earning while the verdict is unconfirmed", async () => {
    seedPlan({ outcome: "LEARNER_ABSENT" });
    expect(await hasReleasableEarningsWork(db(), new Date(), () => false)).toBe(
      false,
    );
    await releaseEarningsFromHold();
    expect(statuses()).toEqual({
      ce_cycle_0: "PENDING",
      ce_cycle_1: "PENDING",
      oe_plan: "PENDING",
    });
  });

  it.each([
    [
      "the verdict is confirmed",
      { outcome: "LEARNER_ABSENT", outcomeConfirmedAt: PAST },
    ],
    ["ops overturn it to held", { outcome: "HELD" }],
  ])("releases all three on the next run once %s", async (_label, absent) => {
    seedPlan(absent);
    await releaseEarningsFromHold();
    expect(statuses()).toEqual({
      ce_cycle_0: "READY",
      ce_cycle_1: "READY",
      oe_plan: "READY",
    });
  });

  it("an overturn to a void no longer holds the plan: the tranche the void un-stamped waits for its cycle, the delivered one releases", async () => {
    // The door's void of a delivered plan session clears the stamp of the tranche it un-delivers.
    seedPlan(
      {
        completionStatus: "VOIDED",
        outcome: "HOST_ABSENT",
        outcomeConfirmedAt: PAST,
        voidedAt: PAST,
      },
      null,
    );
    await releaseEarningsFromHold();
    expect(statuses()).toMatchObject({
      ce_cycle_0: "READY",
      ce_cycle_1: "PENDING",
    });
  });
});

it("a sponsor's trust-park release parks an unconfirmed one as PENDING, not READY", async () => {
  seed("PENDING_TRUST");
  expect(
    await releaseSponsorTrustPark(prisma as never, "org_sponsor"),
  ).toMatchObject({ ready: 0, pending: 2 });
});
