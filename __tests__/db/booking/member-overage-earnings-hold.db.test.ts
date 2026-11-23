/**
 * A booking past its programme cap whose member pays the over-cap amount keeps
 * the expert's earnings on it held until that side payment settles: checkout
 * writes the earnings after the overage is recorded, so they must start held,
 * at the same amounts as an under-cap booking's, and be released by the same
 * paths that release the recorder's hold.
 */
import "./harness-cancel-route";
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import {
  consultationCheckout,
  publishEveryHour,
  seedBuyer,
  seedConsultationPlan,
} from "./harness-host";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
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
import { handleOverageMemberSuccess } from "../../../lib/payments/webhooks/overage-handlers";
import { settleFailedMemberOverageAsOrg } from "../../../lib/payments/billing/overage-settlement";
import { runTimeoutMemberOverages } from "../../../jobs/billing/timeout-member-overages";

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

/** An ACTIVE licence-funded organisation whose member's seat covers `cap` sessions and charges the member past it. */
async function seedLicensedMember(userId: string, cap: number) {
  const org = await prisma.organization.create({
    data: {
      name: "Licensed org",
      slug: `licensed-${randomUUID()}`,
      status: "ACTIVE",
    },
  });
  const account = await prisma.billingAccount.create({
    data: {
      ownerOrgId: org.id,
      billingEmail: `${randomUUID()}@db-tier.example.invalid`,
      fundingSource: "LICENSE",
    },
  });
  await prisma.organization.update({
    where: { id: org.id },
    data: { billingAccountId: account.id },
  });
  const contract = await prisma.contract.create({
    data: {
      organizationId: org.id,
      billingAccountId: account.id,
      status: "ACTIVE",
      effectiveFrom: new Date(Date.now() - DAY_MS),
    },
  });
  const program = await prisma.program.create({
    data: {
      contractId: contract.id,
      type: "LICENSED_SEAT",
      name: "Seat",
      coveredPlanTypes: ["CONSULTATION"],
      licensedSeatConfig: {
        create: {
          ratePerSeatPaise: BigInt(0),
          cycle: "MONTHLY",
          coveredEngagementsPerCycle: cap,
          overageBehavior: "CHARGE_MEMBER",
        },
      },
    },
  });
  const membership = await prisma.membership.create({
    data: { userId, organizationId: org.id, role: "LEARNER" },
  });
  const assignment = await prisma.programAssignment.create({
    data: {
      programId: program.id,
      membershipId: membership.id,
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + 30 * DAY_MS),
    },
  });
  return { orgId: org.id, assignmentId: assignment.id };
}

/** A member of a licensed org books a ₹1,000 consultation on the org's account. */
async function bookOnLicence(cap: number) {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await seedConsultationPlan(host, "Licensed consultation");
  const buyer = await seedBuyer();
  const { orgId } = await seedLicensedMember(buyer.userId, cap);
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
  return { orgId, parent, side };
}

/** The parent's expert earnings with their active holds. */
const earningsOf = (paymentId: string) =>
  prisma.consultantEarnings.findMany({
    where: { paymentId },
    include: {
      holds: {
        where: { releasedAt: null },
        select: { reason: true, sourceRef: true },
      },
    },
  });

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

const overageHeld = (parentId: string) => ({
  status: "HELD",
  preHoldStatus: "PENDING",
  holds: [{ reason: "OVERAGE", sourceRef: parentId }],
});
const released = { status: "PENDING", preHoldStatus: null, holds: [] };

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
  const { assignmentId } = await seedLicensedMember(buyer.userId, 0);
  const utilization = await prisma.bookingUtilization.create({
    data: {
      programAssignmentId: assignmentId,
      paymentId: parent.id,
      priceAtBookingPaise: parent.amount,
      wasOverage: true,
    },
  });
  const side = await prisma.payment.create({
    data: {
      amount: BigInt(23_600),
      originalAmount: BigInt(20_000),
      taxAmount: BigInt(3_600),
      paymentMethod: "CARD",
      paymentIntent: `overage:${parent.id}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId: buyer.userId,
      parentPaymentId: parent.id,
      legs: { create: { source: "CARD", amountPaise: BigInt(23_600) } },
    },
  });
  await prisma.overageEvent.create({
    data: {
      programAssignmentId: assignmentId,
      bookingUtilizationId: utilization.id,
      overageBehavior: "CHARGE_MEMBER",
      surchargePaise: BigInt(20_000),
      marginalPaise: BigInt(23_600),
      chargeStatus: "PENDING",
      paymentId: side.id,
    },
  });

  await handlePaymentSuccess(
    parent.paymentIntent,
    booking.captureMetadata,
    Number(parent.amount),
  );

  const earnings = await earningsOf(parent.id);
  expect(earnings).toHaveLength(1);
  expect(earnings[0]).toMatchObject(overageHeld(parent.id));
});
