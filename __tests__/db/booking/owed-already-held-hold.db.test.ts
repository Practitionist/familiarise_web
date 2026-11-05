/**
 * A door whose refund another door's owed refund already holds (first writer
 * wins) adds no marker; on real Postgres it records one needs-human event and
 * holds the payment's unpaid earnings, consultant and host organisation, under
 * an OPERATOR hold keyed on that event, in the door's own transaction. A replay
 * adds neither a second event nor a second hold. The payment stays on the
 * needs-human list, with the amount to refund by hand, until an operator
 * releases the hold; a payment with nothing left to hold leaves the list once
 * another refund lands on it.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { seedConsultee, seedHost } from "./harness";

jest.mock("../../../lib/payments/payouts/earnings-holds", () => {
  const actual = jest.requireActual(
    "../../../lib/payments/payouts/earnings-holds",
  );
  return { ...actual, placeEarningsHolds: jest.fn(actual.placeEarningsHolds) };
});

import {
  OWED_ALREADY_HELD_PREFIX,
  stampOwedOrHeld,
  type RefundOwedMarker,
} from "../../../lib/payments/operations/refund-owed";
import { readOwedAlreadyHeld } from "../../../lib/backoffice/needs-human";
import { releaseHeldEarnings } from "../../../lib/payments/payouts/earnings-hold-ops";

const PRICE = 100_000;

/** A paid class seat whose payment owes another door's ₹10, with its earnings unpaid or paid. */
async function seedHeldPayment(
  earnings: "PENDING" | "PAID",
  opts: { heldPaise?: number | null } = {},
) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  // The first door's marker; the key is unique across payments.
  const heldKey = `occ:${randomUUID()}:pay:held`;
  const org = await prisma.organization.create({
    data: { name: "Host org", slug: `db-tier-${randomUUID()}` },
  });
  const plan = await prisma.classPlan.create({
    data: {
      title: `Database tier class ${randomUUID().slice(0, 8)}`,
      price: BigInt(PRICE),
      totalSessions: 4,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const cls = await prisma.class.create({
    data: { classPlanId: plan.id, status: "SCHEDULED" },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "CLASS", classId: cls.id },
  });
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(PRICE),
      originalAmount: BigInt(PRICE),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: appointment.id,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(PRICE) }] },
      refundOwedKey: heldKey,
      refundOwedPaise:
        opts.heldPaise === null ? null : BigInt(opts.heldPaise ?? 1_000),
      refundOwedReason: "an earlier refund",
      refundOwedAt: new Date(),
    },
  });
  const consultantEarning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(PRICE),
      platformFeePaise: BigInt(20_000),
      consultantSharePaise: BigInt(70_000),
      cycleOrdinal: 0,
      status: earnings,
      holdUntil: null,
    },
  });
  const orgEarning = await prisma.organizationEarnings.create({
    data: {
      organizationId: org.id,
      paymentId: payment.id,
      grossAmountPaise: BigInt(PRICE),
      platformFeePaise: BigInt(20_000),
      orgSharePaise: BigInt(10_000),
      consultantSharePaise: BigInt(70_000),
      status: earnings,
      holdUntil: null,
    },
  });
  return {
    heldKey,
    paymentId: payment.id,
    consultantEarningId: consultantEarning.id,
    orgEarningId: orgEarning.id,
    adminUserId: host.userId,
  };
}

type Seeded = Awaited<ReturnType<typeof seedHeldPayment>>;

/** A SUCCEEDED refund on the payment, as an operator door or the holding drive writes it. */
async function handRefund(
  paymentId: string,
  amountPaise: number,
  dedupeKey = `ops:${randomUUID()}`,
  createdAt = new Date(),
) {
  await prisma.refund.create({
    data: {
      paymentId,
      amountPaise: BigInt(amountPaise),
      status: "SUCCEEDED",
      refundId: `rfnd_dbtier_${randomUUID()}`,
      dedupeKey,
      paymentGateway: "RAZORPAY",
      createdAt,
    },
  });
}

const losingMarker = (s: Seeded): RefundOwedMarker => ({
  paymentId: s.paymentId,
  amountPaise: 25_000,
  key: `consultant-no-show:${s.paymentId}`,
  reason: "the expert did not join",
});

const lose = (s: Seeded) =>
  prisma.$transaction((tx) => stampOwedOrHeld(tx, losingMarker(s)));

const correlationOf = (s: Seeded) =>
  `${OWED_ALREADY_HELD_PREFIX}${s.paymentId}:${losingMarker(s).key}`;

const listed = async (s: Seeded) =>
  (await readOwedAlreadyHeld()).filter((i) => i.paymentId === s.paymentId);

describe("a door whose refund another door's owed refund holds", () => {
  it("holds the payment's earnings until an operator releases them, listed with the amount to refund by hand", async () => {
    const s = await seedHeldPayment("PENDING");

    const held = await lose(s);
    expect(held).toMatchObject({ heldKey: s.heldKey, heldPaise: 1_000 });
    await lose(s);

    // The first door's marker stays; this door added none.
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: s.paymentId },
      select: { refundOwedKey: true },
    });
    expect(payment.refundOwedKey).toBe(s.heldKey);

    const events = await prisma.systemEvent.findMany({
      where: { correlationId: correlationOf(s) },
    });
    expect(events).toHaveLength(1);
    const holds = await prisma.earningsHold.findMany({
      where: { sourceRef: correlationOf(s) },
      select: {
        reason: true,
        releasedAt: true,
        consultantEarningsId: true,
        organizationEarningsId: true,
      },
    });
    expect(holds).toHaveLength(2);
    expect(holds.every((h) => h.reason === "OPERATOR")).toBe(true);
    expect(holds.every((h) => h.releasedAt === null)).toBe(true);
    const consultant = await prisma.consultantEarnings.findUniqueOrThrow({
      where: { id: s.consultantEarningId },
      select: { status: true },
    });
    const org = await prisma.organizationEarnings.findUniqueOrThrow({
      where: { id: s.orgEarningId },
      select: { status: true },
    });
    expect(consultant.status).toBe("HELD");
    expect(org.status).toBe("HELD");

    expect(await listed(s)).toEqual([
      expect.objectContaining({
        kind: "owed-already-held",
        amountPaise: 25_000,
        message: `Payment ${s.paymentId} (${s.heldKey}): Another refund is still owed on this payment; refund the remaining ₹250.00 by hand, then release the hold.`,
      }),
    ]);

    // An unrelated release of the hold does not close the row: the money is still owed.
    await prisma.$transaction((tx) =>
      releaseHeldEarnings(
        tx,
        s.consultantEarningId,
        "released for another reason",
        s.adminUserId,
      ),
    );
    expect(await listed(s)).toEqual([
      expect.objectContaining({ amountPaise: 25_000 }),
    ]);

    // The hand top-up settles the money; the row then asks for the hold release.
    await handRefund(s.paymentId, 25_000);
    expect(await listed(s)).toEqual([
      expect.objectContaining({
        amountPaise: null,
        message: `Payment ${s.paymentId} (${s.heldKey}): the top-up is settled; release the hold on its earnings.`,
      }),
    ]);
    await prisma.$transaction((tx) =>
      releaseHeldEarnings(
        tx,
        s.orgEarningId,
        "topped up by hand",
        s.adminUserId,
      ),
    );
    expect(await listed(s)).toEqual([]);
  });

  it("with nothing left to hold, stays listed until a refund other than the holding marker's covers it", async () => {
    const s = await seedHeldPayment("PAID");
    await lose(s);
    expect(
      await prisma.earningsHold.count({
        where: { sourceRef: correlationOf(s) },
      }),
    ).toBe(0);
    expect(await listed(s)).toEqual([
      expect.objectContaining({
        message: `Payment ${s.paymentId} (${s.heldKey}): Another refund is still owed on this payment; refund the remaining ₹250.00 by hand.`,
      }),
    ]);

    // The first door's own refund does not answer it; a hand refund does.
    await handRefund(s.paymentId, 1_000, s.heldKey);
    expect(await listed(s)).toHaveLength(1);
    await handRefund(s.paymentId, 25_000);
    expect(await listed(s)).toEqual([]);
  });

  it("closes once the payment has nothing left to refund", async () => {
    const s = await seedHeldPayment("PAID");
    await lose(s);
    expect(await listed(s)).toHaveLength(1);
    // A refund dated before the event is no top-up, but it leaves nothing to refund.
    await handRefund(
      s.paymentId,
      PRICE,
      `earlier:${randomUUID()}`,
      new Date(Date.now() - 3_600_000),
    );
    expect(await listed(s)).toEqual([]);
  });

  it("a full-balance holding marker already covers the door: no event and no hold", async () => {
    const s = await seedHeldPayment("PENDING", { heldPaise: null });
    expect(await lose(s)).toMatchObject({ heldPaise: null });
    expect(
      await prisma.systemEvent.count({
        where: { correlationId: correlationOf(s) },
      }),
    ).toBe(0);
    expect(
      await prisma.earningsHold.count({
        where: { sourceRef: correlationOf(s) },
      }),
    ).toBe(0);
  });

  it("a holding refund still in flight at the gateway is not counted twice: the door records and holds", async () => {
    const s = await seedHeldPayment("PENDING", { heldPaise: 70_000 });
    await prisma.refund.create({
      data: {
        paymentId: s.paymentId,
        amountPaise: BigInt(70_000),
        status: "PENDING",
        refundId: `rfnd_dbtier_${randomUUID()}`,
        dedupeKey: s.heldKey,
        paymentGateway: "RAZORPAY",
      },
    });
    await lose(s);
    const event = await prisma.systemEvent.findFirstOrThrow({
      where: { correlationId: correlationOf(s) },
      select: { context: true },
    });
    expect(event.context).toMatchObject({ owedPaise: 25_000 });
    expect(
      await prisma.earningsHold.count({
        where: { sourceRef: correlationOf(s) },
      }),
    ).toBe(2);
  });

  it("a hold that races rolls the door back: no earning is left HELD without an active hold", async () => {
    const s = await seedHeldPayment("PENDING");
    const place = jest.requireMock(
      "../../../lib/payments/payouts/earnings-holds",
    ).placeEarningsHolds as jest.Mock;
    const actual = jest.requireActual(
      "../../../lib/payments/payouts/earnings-holds",
    ) as typeof import("../../../lib/payments/payouts/earnings-holds");
    // The consultant rail holds its row; the org rail's row keeps moving.
    place
      .mockImplementationOnce(actual.placeEarningsHolds)
      .mockImplementationOnce(
        async (_db: unknown, side: "org", ids: string[]) => {
          throw new actual.EarningsHoldRaceError(side, ids);
        },
      );

    await expect(lose(s)).rejects.toBeInstanceOf(actual.EarningsHoldRaceError);

    const consultant = await prisma.consultantEarnings.findUniqueOrThrow({
      where: { id: s.consultantEarningId },
      select: { status: true, preHoldStatus: true },
    });
    expect(consultant).toEqual({ status: "PENDING", preHoldStatus: null });
    expect(
      await prisma.earningsHold.count({
        where: { sourceRef: correlationOf(s) },
      }),
    ).toBe(0);
    expect(
      await prisma.systemEvent.count({
        where: { correlationId: correlationOf(s) },
      }),
    ).toBe(0);
  });
});
