/**
 * @jest-environment node
 */

// Invariant: a subscription tranche whose stamped hold has passed is released
// although later sessions of its plan are still scheduled. Every other release
// gate still holds it, an unstamped tranche stays, the plan's organisation
// earning waits for the whole plan, and no other earning is released while a
// session of its booking is undelivered.

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
  type EarningsTable as Table,
} from "../fixtures/earnings-release-world";
import {
  hasReleasableEarningsWork,
  releaseEarningsFromHold,
} from "@/scripts/earnings/release-earnings";

const consultantEarnings = prisma.consultantEarnings as unknown as Table;
const organizationEarnings = prisma.organizationEarnings as unknown as Table;

const session = (completionStatus: string, over: Row = {}): Row => ({
  completionStatus,
  deletedAt: null,
  isTentative: false,
  outcome: null,
  outcomeConfirmedAt: null,
  seatsSettledAt: null,
  hostCancelledAt: null,
  voidedAt: null,
  meeting: null,
  ...over,
});

/** A plan with its first cycle delivered and a later session still on the calendar. */
function planPayment(over: Row = {}): Row {
  const appointment: Row = { subscriptionId: "sub_1", payment: [] };
  appointment.occurrences = [
    session("COMPLETED", { appointment }),
    session("SCHEDULED", { appointment }),
  ];
  return {
    id: "pay_plan",
    appointmentId: "appt_plan",
    appointment,
    refunds: [],
    disputes: [],
    refundOwedKey: null,
    ...over,
  };
}

const earning = (id: string, payment: Row, over: Row = {}): Row => ({
  id,
  status: "PENDING",
  holdUntil: PAST,
  cycleOrdinal: null,
  consultantSharePaise: 80_000,
  consultantProfile: { user: { name: "C", email: "c@x" } },
  payment,
  ...over,
});

function seed(payment: Row, extra: Row[] = []) {
  consultantEarnings.rows.splice(
    0,
    consultantEarnings.rows.length,
    earning("delivered", payment, { cycleOrdinal: 0 }),
    earning("undelivered", payment, { cycleOrdinal: 1, holdUntil: null }),
    ...extra,
  );
  organizationEarnings.rows.splice(0, organizationEarnings.rows.length, {
    id: "plan_org",
    status: "PENDING",
    holdUntil: PAST,
    orgSharePaise: 10_000,
    organization: { name: "Host org" },
    payment,
  });
}

const statusOf = (id: string) =>
  consultantEarnings.rows.find((r) => r.id === id)?.status;

beforeEach(() => jest.clearAllMocks());

it("releases the delivered tranche on its own date and nothing else", async () => {
  const consultation: Row = { subscriptionId: null, payment: [] };
  consultation.occurrences = [
    session("SCHEDULED", { appointment: consultation }),
  ];
  seed(planPayment(), [
    earning("other_booking", {
      id: "pay_consult",
      appointmentId: "appt_consult",
      appointment: consultation,
      refunds: [],
      disputes: [],
      refundOwedKey: null,
    }),
  ]);

  const out = await releaseEarningsFromHold();

  expect(out).toMatchObject({
    releasedCount: 1,
    organizationEarningsReleased: 0,
  });
  expect(statusOf("delivered")).toBe("READY");
  expect(statusOf("undelivered")).toBe("PENDING");
  expect(statusOf("other_booking")).toBe("PENDING");
  expect(organizationEarnings.rows[0].status).toBe("PENDING");
});

it.each<[string, () => Row]>([
  [
    "a refund in flight",
    () => planPayment({ refunds: [{ amountPaise: 5_000, status: "PENDING" }] }),
  ],
  ["an owed refund", () => planPayment({ refundOwedKey: "plan-end:sub_1" })],
  [
    "an active dispute",
    () => planPayment({ disputes: [{ status: "NEEDS_RESPONSE" }] }),
  ],
  [
    "a session awaiting a person",
    () => {
      const payment = planPayment();
      const appointment = payment.appointment as Row;
      (appointment.occurrences as Row[]).push(
        session("UNVERIFIED", { outcome: "INCONCLUSIVE", appointment }),
      );
      return payment;
    },
  ],
])("%s still holds the delivered tranche", async (_label, payment) => {
  seed(payment());

  expect(
    await hasReleasableEarningsWork(
      { consultantEarnings, organizationEarnings } as never,
      new Date(),
      () => false,
    ),
  ).toBe(false);
  const out = await releaseEarningsFromHold();

  expect(out.releasedCount).toBe(0);
  expect(statusOf("delivered")).toBe("PENDING");
});

it.each<[string, Date | null, string]>([
  ["is held while that verdict is unconfirmed", null, "PENDING"],
  ["is released once that verdict is confirmed", PAST, "READY"],
])(
  "a dated tranche whose delivered session was a learner absence, with a later session still scheduled, %s",
  async (_label, outcomeConfirmedAt, status) => {
    const payment = planPayment();
    const appointment = payment.appointment as Row;
    Object.assign((appointment.occurrences as Row[])[0], {
      outcome: "LEARNER_ABSENT",
      outcomeConfirmedAt,
    });
    seed(payment);

    await releaseEarningsFromHold();

    // The later session never holds the dated tranche; only the unconfirmed verdict does.
    expect(statusOf("delivered")).toBe(status);
    expect(statusOf("undelivered")).toBe("PENDING");
  },
);

it("the claim keeps a tranche whose stamp a void cleared after the read", async () => {
  seed(planPayment());
  consultantEarnings.findMany.mockImplementationOnce(async () => {
    const read = consultantEarnings.rows
      .filter((r) => r.id === "delivered")
      .map((r) => ({ ...r }));
    consultantEarnings.rows[0].holdUntil = null;
    return read;
  });

  const out = await releaseEarningsFromHold();

  expect(out.releasedCount).toBe(0);
  expect(statusOf("delivered")).toBe("PENDING");
});
