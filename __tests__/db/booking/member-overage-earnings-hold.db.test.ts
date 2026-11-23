/**
 * A booking past its programme cap whose member pays the over-cap amount keeps
 * the expert's earnings on it held until that side payment settles: checkout
 * writes the earnings after the overage is recorded, so they must start held,
 * at the same amounts as an under-cap booking's, and be released by the same
 * paths that release the recorder's hold.
 */
import "./harness-cancel-route";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  seedPaidSubscription,
} from "./harness";
import {
  consultationCheckout,
  publishEveryHour,
  seedBuyer,
  seedConsultationPlan,
} from "./harness-host";
import {
  earningsOf,
  overageHeld,
  released,
  seedIssuedInvoice,
  seedSponsoredMember,
  seedUnpaidMemberOverage,
  type Sponsor,
} from "./harness-overage";
import { sessionUser } from "./harness-session";

jest.mock("../../../lib/payments/index", () =>
  jest.requireActual("./harness-edges").orderGatewayMock(),
);
jest.mock("../../../lib/compliance/dpdp", () =>
  jest.requireActual("./harness-edges").consentGrantedMock(),
);
// A retried overage mints its order here; the shared reader stays real.
jest.mock("../../../lib/payments/core/razorpay", () => ({
  ...jest.requireActual("../../../lib/payments/core/razorpay"),
  getRazorpayClient: () => null,
  createRazorpayOrder: jest.fn(
    async (args: { amount: number; currency: string }) => ({
      id: `order_${globalThis.crypto.randomUUID()}`,
      amount: args.amount,
      currency: args.currency,
    }),
  ),
}));
jest.mock("../../../lib/novu/org-workflows", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/payments/billing/consumer-invoice", () => ({
  __esModule: true,
  mintConsumerInvoiceBestEffort: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn(async () => ({ ensured: true })),
}));
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  ...jest.requireActual("../../../lib/cron/with-cron-lock"),
  withCronLock: (_job: string, _opts: unknown, run: () => Promise<unknown>) =>
    run(),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import {
  handleOverageMemberFailure,
  handleOverageMemberSuccess,
} from "../../../lib/payments/webhooks/overage-handlers";
import { POST as retryOverage } from "../../../app/api/overage/[overageEventId]/order/route";
import { releaseSponsorTrustPark } from "../../../lib/payments/payouts/trust-park";
import { settleOrgInvoicePaid } from "../../../lib/payments/billing/org-invoice-settlement";
import { settleFailedMemberOverageAsOrg } from "../../../lib/payments/billing/overage-settlement";
import { runTimeoutMemberOverages } from "../../../jobs/billing/timeout-member-overages";
import { replaceOccurrence } from "../../../lib/appointments/occurrences";
import { settleSubscriptionCycle } from "../../../lib/booking/subscription-cycle";
import {
  computeHoldUntil,
  holdHoursFor,
  recomputeEarningsHold,
} from "../../../lib/payments/payouts/earnings-hold";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "../../../lib/payments/payouts";

const DAY_MS = 24 * HOUR_MS;
const OLD_GSTIN = process.env.PLATFORM_GSTIN;
// Organisation rails need a GST-registered platform.
beforeAll(() => {
  process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
});
afterAll(() => {
  if (OLD_GSTIN === undefined) delete process.env.PLATFORM_GSTIN;
  else process.env.PLATFORM_GSTIN = OLD_GSTIN;
});

/** A member of a sponsoring org (licensed by default) books a ₹1,000 consultation on the org's account. */
async function bookOnLicence(cap: number, sponsor?: Sponsor) {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await seedConsultationPlan(host, "Sponsored consultation");
  const buyer = await seedBuyer();
  const { orgId, billingAccountId } = await seedSponsoredMember(
    buyer.userId,
    cap,
    sponsor,
  );
  await handleCheckout(
    {
      ...consultationCheckout(plan.id, futureAt(6, 10), `lic-${randomUUID()}`),
      organizationId: orgId,
    },
    buyer.userId,
  );
  const parent = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId, parentPaymentId: null },
  });
  const side = await prisma.payment.findFirst({
    where: { parentPaymentId: parent.id },
  });
  return { orgId, billingAccountId, buyer, parent, side };
}

/** Every column an earning's amounts are made of. */
const amountsOf = (rows: Awaited<ReturnType<typeof earningsOf>>) =>
  rows.map((r) => ({
    grossAmount: r.grossAmount,
    platformFeePaise: r.platformFeePaise,
    consultantSharePaise: r.consultantSharePaise,
    refundedShareAmount: r.refundedShareAmount,
    role: r.role,
    shareBps: r.shareBps,
    cycleOrdinal: r.cycleOrdinal,
    currency: r.currency,
  }));

describe("a licence-funded booking past its cap whose member pays the overage", () => {
  it("writes the parent's earnings held for the member's unpaid overage", async () => {
    const { parent, side } = await bookOnLicence(0);

    expect(side).toMatchObject({ paymentStatus: "PENDING" });
    const earnings = await earningsOf(parent.id);
    expect(earnings).toHaveLength(1);
    expect(earnings[0]).toMatchObject(overageHeld(parent.id));
  });

  it("holds earnings of the same amounts as an under-cap booking's", async () => {
    const overCap = await bookOnLicence(0);
    const underCap = await bookOnLicence(5);

    expect(underCap.side).toBeNull();
    const held = await earningsOf(overCap.parent.id);
    const plain = await earningsOf(underCap.parent.id);
    expect(plain[0]).toMatchObject(released);
    expect(amountsOf(held)).toEqual(amountsOf(plain));
    expect(Number(held[0].grossAmount)).toBe(100_000);
  });

  it("releases the hold when the member pays", async () => {
    const { parent, side } = await bookOnLicence(0);
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      overageHeld(parent.id),
    );

    await handleOverageMemberSuccess(side!.paymentIntent, Number(side!.amount));

    expect((await earningsOf(parent.id))[0]).toMatchObject(released);
  });

  it("moves a held earning's release with its session, so paying waits for the new end", async () => {
    const { parent, side } = await bookOnLicence(0);
    const [earning] = await earningsOf(parent.id);
    const session = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: { appointmentId: parent.appointmentId! },
    });
    // Further out than the new-expert days, so only a re-anchor can match.
    const startsAt = new Date(session.startsAt.getTime() + 10 * DAY_MS);

    await prisma.$transaction((tx) =>
      replaceOccurrence(tx, {
        appointmentId: parent.appointmentId!,
        startsAt,
        durationInHours: 1,
        consultantProfileId: session.consultantProfileId!,
      }),
    );

    const holdUntil = computeHoldUntil({
      capturedAt: earning.createdAt,
      lastOccurrenceEndsAt: new Date(startsAt.getTime() + HOUR_MS),
      holdHours: holdHoursFor("CONSULTATION"),
    });
    expect((await earningsOf(parent.id))[0]).toMatchObject({
      ...overageHeld(parent.id),
      holdUntil,
    });
    await handleOverageMemberSuccess(side!.paymentIntent, Number(side!.amount));
    expect((await earningsOf(parent.id))[0]).toMatchObject({
      ...released,
      holdUntil,
    });
  });

  it("keeps the hold when the overage times out, until it is settled to the org", async () => {
    const { orgId, parent } = await bookOnLicence(0);
    const event = await prisma.overageEvent.findFirstOrThrow({
      where: { payment: { parentPaymentId: parent.id } },
    });

    await runTimeoutMemberOverages({
      windowStart: new Date(Date.now() + 15 * DAY_MS),
    });

    expect(
      (await prisma.overageEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .chargeStatus,
    ).toBe("FAILED");
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      overageHeld(parent.id),
    );

    await prisma.$transaction((tx) =>
      settleFailedMemberOverageAsOrg(tx, {
        organizationId: orgId,
        overageEventId: event.id,
      }),
    );

    expect((await earningsOf(parent.id))[0]).toMatchObject(released);
  });
});

it("a gateway capture writes its earnings held while a member overage on the payment is unpaid", async () => {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(4, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: { status: "PENDING" },
    },
  );
  const parent = booking.payment!;
  await seedUnpaidMemberOverage(parent, buyer.userId);

  await handlePaymentSuccess(
    parent.paymentIntent,
    booking.captureMetadata,
    Number(parent.amount),
  );

  const earnings = await earningsOf(parent.id);
  expect(earnings).toHaveLength(1);
  expect(earnings[0]).toMatchObject(overageHeld(parent.id));
});

/**
 * A paid two-session subscription whose tranches the deferred writer (the
 * capture's post-commit retry, the heal sweep) mints; `held` leaves a member
 * overage unpaid on it first.
 */
async function mintSubscription(held: boolean) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const periodStart = new Date(Date.now() - 20 * DAY_MS);
  const { subscriptionId, appointmentId } = await seedPaidSubscription(
    host,
    buyer,
    periodStart,
    { sessionsPerWeek: 1, totalSessions: 2 },
  );
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: "APPROVED" },
  });
  const parent = await prisma.payment.findFirstOrThrow({
    where: { appointmentId },
  });
  const side = held
    ? await seedUnpaidMemberOverage(parent, buyer.userId)
    : null;
  const resolved = await resolvePaymentForEarnings(
    { id: parent.id },
    "SUBSCRIPTION",
  );
  await createEarningsFromPayment({
    payment: resolved!.paymentForEarnings,
    appointmentType: resolved!.earningsAppointmentType,
    teamAt: parent.createdAt,
  });
  return { host, appointmentId, periodStart, parent, side };
}

/** One confirmed hour-long session on the subscription. */
const addSession = (
  appointmentId: string,
  consultantProfileId: string,
  at: {
    ordinal: number;
    startsAt: Date;
    completionStatus: "COMPLETED" | "SCHEDULED";
  },
) =>
  prisma.appointmentOccurrence.create({
    data: {
      appointmentId,
      ...at,
      endsAt: new Date(at.startsAt.getTime() + HOUR_MS),
      isTentative: false,
      consultantProfileId,
    },
  });

it("stamps a delivered subscription tranche while it is held, so paying the overage lets it release", async () => {
  const { host, appointmentId, periodStart, parent, side } =
    await mintSubscription(true);
  const minted = await earningsOf(parent.id);
  expect(minted.length).toBeGreaterThan(0);
  for (const tranche of minted) {
    expect(tranche).toMatchObject({
      ...overageHeld(parent.id),
      holdUntil: null,
    });
  }

  // Both sessions are delivered while the overage is unpaid.
  for (const ordinal of [1, 2]) {
    await addSession(appointmentId, host.consultantProfileId, {
      ordinal,
      startsAt: new Date(periodStart.getTime() + ordinal * 7 * DAY_MS),
      completionStatus: "COMPLETED",
    });
  }
  await prisma.$transaction((tx) =>
    settleSubscriptionCycle(tx, { appointmentId, now: new Date() }),
  );
  await handleOverageMemberSuccess(side!.paymentIntent, Number(side!.amount));

  for (const tranche of await earningsOf(parent.id)) {
    expect(tranche).toMatchObject(released);
    expect(tranche.holdUntil).not.toBeNull();
  }
});

describe("a delivered subscription tranche keeps its stamped date when a later cycle is scheduled", () => {
  /** A two-cycle subscription whose first cycle is delivered and settled; `held` leaves a member overage unpaid on it. */
  async function deliverFirstCycle(held: boolean) {
    const { host, appointmentId, periodStart, parent, side } =
      await mintSubscription(held);
    await addSession(appointmentId, host.consultantProfileId, {
      ordinal: 1,
      startsAt: new Date(periodStart.getTime() + 7 * DAY_MS),
      completionStatus: "COMPLETED",
    });
    await prisma.$transaction((tx) =>
      settleSubscriptionCycle(tx, { appointmentId, now: new Date() }),
    );
    const [tranche] = await earningsOf(parent.id);
    expect(tranche).toMatchObject({ cycleOrdinal: 0 });
    expect(tranche.holdUntil).not.toBeNull();
    return { host, appointmentId, parent, side, stamped: tranche.holdUntil };
  }

  /** The expert places cycle 2 ten days out; allocation re-anchors the appointment's holds. */
  async function scheduleSecondCycle(
    appointmentId: string,
    consultantProfileId: string,
  ) {
    await addSession(appointmentId, consultantProfileId, {
      ordinal: 2,
      startsAt: new Date(Date.now() + 10 * DAY_MS),
      completionStatus: "SCHEDULED",
    });
    await recomputeEarningsHold(prisma, appointmentId);
  }

  it("held for an unpaid overage: the tranche keeps its stamp through the payment", async () => {
    const { host, appointmentId, parent, side, stamped } =
      await deliverFirstCycle(true);
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      overageHeld(parent.id),
    );

    await scheduleSecondCycle(appointmentId, host.consultantProfileId);
    await handleOverageMemberSuccess(side!.paymentIntent, Number(side!.amount));

    expect((await earningsOf(parent.id))[0]).toMatchObject({
      ...released,
      cycleOrdinal: 0,
      holdUntil: stamped,
    });
  });

  it("unheld: the tranche keeps its stamp", async () => {
    const { host, appointmentId, parent, stamped } =
      await deliverFirstCycle(false);

    await scheduleSecondCycle(appointmentId, host.consultantProfileId);

    expect((await earningsOf(parent.id))[0]).toMatchObject({
      ...released,
      cycleOrdinal: 0,
      holdUntil: stamped,
    });
  });
});

describe("an unverified invoice sponsor's booking past its cap", () => {
  const unverified: Sponsor = {
    fundingSource: "INVOICE",
    status: "PENDING_VERIFICATION",
  };
  const trustParkedHeld = (parentId: string) => ({
    ...overageHeld(parentId),
    preHoldStatus: "PENDING_TRUST",
  });

  it("holds the trust-parked earning; verifying the sponsor lifts only the trust park", async () => {
    const { orgId, parent, side } = await bookOnLicence(0, unverified);
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      trustParkedHeld(parent.id),
    );

    await prisma.$transaction((tx) => releaseSponsorTrustPark(tx, orgId));
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      overageHeld(parent.id),
    );

    await handleOverageMemberSuccess(side!.paymentIntent, Number(side!.amount));
    expect((await earningsOf(parent.id))[0]).toMatchObject(released);
  });

  it("paying the sponsor's first invoice lifts only the trust park", async () => {
    const { orgId, billingAccountId, parent, side } = await bookOnLicence(
      0,
      unverified,
    );
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      trustParkedHeld(parent.id),
    );
    const invoice = await seedIssuedInvoice(orgId, billingAccountId);

    await prisma.$transaction((tx) =>
      settleOrgInvoicePaid(tx, {
        invoiceId: invoice.id,
        paidAt: new Date(),
        providerPaymentId: null,
        paymentRef: "bank-transfer",
      }),
    );
    expect((await earningsOf(parent.id))[0]).toMatchObject(
      overageHeld(parent.id),
    );

    await handleOverageMemberSuccess(side!.paymentIntent, Number(side!.amount));
    expect((await earningsOf(parent.id))[0]).toMatchObject(released);
  });
});

it("a member retrying a failed overage puts the earnings hold back", async () => {
  const { buyer, parent, side } = await bookOnLicence(0, {
    fundingSource: "INVOICE",
    status: "ACTIVE",
  });
  const event = await prisma.overageEvent.findFirstOrThrow({
    where: { paymentId: side!.id },
  });
  // The failure gives the base back to the org's accrual and releases the hold.
  await handleOverageMemberFailure(side!.paymentIntent);
  expect((await earningsOf(parent.id))[0]).toMatchObject(released);

  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  const res = await retryOverage(
    new NextRequest(`http://localhost/api/overage/${event.id}/order`, {
      method: "POST",
    }),
    { params: Promise.resolve({ overageEventId: event.id }) },
  );

  expect(res.status).toBe(200);
  expect(
    (await prisma.overageEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .chargeStatus,
  ).toBe("PENDING");
  expect((await earningsOf(parent.id))[0]).toMatchObject(
    overageHeld(parent.id),
  );
});
