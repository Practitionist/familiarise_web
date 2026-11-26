/**
 * Every class remedy waits for a pending void's verdict, on real Postgres.
 * An 80,000-paise class of four sessions: one held, one voided CUT_SHORT with
 * its verdict unconfirmed, two days away. An ordinary leave, the host's
 * whole-class cancel and a make-up skip each refuse while the verdict is
 * pending, writing nothing; once ops confirm the void each pays it, and once
 * ops relabel it held, the leave and the cancel leave it out.
 */
import "./harness-cancel-route";

/** Delays the skip's next seat-ledger read, once: the last read before it judges the make-up's start. */
const mockSlowLedger = { ms: 0 };
jest.mock("../../../lib/booking/class-series", () => {
  const actual = jest.requireActual("../../../lib/booking/class-series");
  return {
    ...actual,
    seatLedger: async (...args: unknown[]) => {
      const { ms } = mockSlowLedger;
      mockSlowLedger.ms = 0;
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      return actual.seatLedger(...args);
    },
  };
});

import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import { skipClassMakeUp } from "../../../lib/booking/class-sessions";
import {
  confirmSessionOutcome,
  overturnSessionOutcome,
} from "../../../lib/backoffice/session-outcomes";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";
import {
  hostCancels,
  seatClassBuyer,
  seedClassUnderWay,
} from "./harness-class-series";
import { seedSeatBuyer } from "./harness-seats";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";
import { withAppointmentLock } from "../../../utils/appointmentlock";

refundOnRowsEachTest();

const DAY_MS = 24 * HOUR_MS;
const SHAPE = { price: 80_000, sessions: 4, delivered: 1 };

/** A free seat: a price-free order, nothing paid and no credit spent. */
async function seatFreeBuyer(cls: { appointmentId: string }) {
  const buyer = await seedSeatBuyer();
  const boughtAt = new Date(Date.now() - 20 * DAY_MS);
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(0),
      originalAmount: BigInt(0),
      paymentMethod: "free",
      paymentIntent: `free_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: cls.appointmentId,
      isMockPayment: true,
      createdAt: boughtAt,
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: cls.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "CONFIRMED",
      paymentId: payment.id,
      sessionsPurchased: SHAPE.sessions,
      createdAt: boughtAt,
    },
  });
  return { userId: buyer.userId, paymentId: payment.id };
}

/** The class, its seat (paid unless `free`), and session 2 voided yesterday as CUT_SHORT, unconfirmed. */
async function seedPendingVoid({ free = false } = {}) {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  const buyer = free
    ? await seatFreeBuyer(cls)
    : await seatClassBuyer(cls, SHAPE);
  const voidId = cls.occurrenceIds[1];
  const startsAt = new Date(Date.now() - 2 * DAY_MS);
  await prisma.appointmentOccurrence.update({
    where: { id: voidId },
    data: {
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
      completionStatus: "VOIDED",
      voidedAt: new Date(Date.now() - DAY_MS),
      outcome: "CUT_SHORT",
      outcomeAt: new Date(Date.now() - DAY_MS),
      outcomeConfirmedAt: null,
    },
  });
  return { host, cls, buyer, voidId };
}

const confirmVoid = (voidId: string) =>
  prisma.$transaction((tx) =>
    confirmSessionOutcome(tx, { occurrenceId: voidId, outcome: "CUT_SHORT" }),
  );

const relabelHeld = async (voidId: string) =>
  overturnSessionOutcome({
    occurrenceId: voidId,
    outcome: "HELD",
    actorUserId: (await seedConsultee()).userId,
  });

const seatStatus = async (appointmentId: string, userId: string) =>
  (
    await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId, userId },
      select: { status: true },
    })
  ).status;

const leave = (classId: string, userId: string) =>
  leaveEventSeat({
    kind: "class",
    eventId: classId,
    userId,
    actorUserId: userId,
    isSelfLeave: true,
  });

const classStatus = async (classId: string) =>
  (await prisma.class.findUniqueOrThrow({ where: { id: classId } })).status;

describe("an ordinary leave", () => {
  it("waits for the verdict with nothing written, then refunds the two future sessions and the confirmed void", async () => {
    const { cls, buyer, voidId } = await seedPendingVoid();

    await expect(leave(cls.classId, buyer.userId)).rejects.toMatchObject({
      code: "EXIT_WAITS_FOR_VERDICT",
      message: expect.stringContaining(
        "You can leave the series once it's settled; the report window closes ",
      ),
    });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);
    expect(await seatStatus(cls.appointmentId, buyer.userId)).toBe("CONFIRMED");

    await confirmVoid(voidId);
    expect(await leave(cls.classId, buyer.userId)).not.toBeNull();
    expect(await refundedPaise(buyer.paymentId)).toBe(40_000 + 20_000);
  });

  it("leaves the void out once ops relabel it held", async () => {
    const { cls, buyer, voidId } = await seedPendingVoid();
    await relabelHeld(voidId);
    expect(await leave(cls.classId, buyer.userId)).not.toBeNull();
    expect(await refundedPaise(buyer.paymentId)).toBe(40_000);
  });

  it("lets a free seat leave at once while the paid seat in the same class still waits", async () => {
    const { cls, buyer } = await seedPendingVoid();
    const free = await seatFreeBuyer(cls);

    expect(await leave(cls.classId, free.userId)).not.toBeNull();
    expect(await seatStatus(cls.appointmentId, free.userId)).not.toBe(
      "CONFIRMED",
    );
    expect(
      await prisma.refund.count({ where: { paymentId: free.paymentId } }),
    ).toBe(0);
    await expect(leave(cls.classId, buyer.userId)).rejects.toMatchObject({
      code: "EXIT_WAITS_FOR_VERDICT",
    });
  });
});

describe("the host's whole-class cancel", () => {
  it("waits for the verdict with nothing written, then refunds the two future sessions and the confirmed void", async () => {
    const { host, cls, buyer, voidId } = await seedPendingVoid();

    const refused = await hostCancels(host, cls.appointmentId);
    expect(refused).toMatchObject({
      status: 409,
      body: {
        code: "CANCEL_WAITS_FOR_VERDICT",
        error: expect.stringContaining(
          "You can cancel the class once it's settled; the report window closes ",
        ),
      },
    });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);
    expect(await classStatus(cls.classId)).toBe("SCHEDULED");

    await confirmVoid(voidId);
    expect((await hostCancels(host, cls.appointmentId)).status).toBe(200);
    expect(await refundedPaise(buyer.paymentId)).toBe(40_000 + 20_000);
  });

  it("leaves the void out once ops relabel it held", async () => {
    const { host, cls, buyer, voidId } = await seedPendingVoid();
    await relabelHeld(voidId);
    expect((await hostCancels(host, cls.appointmentId)).status).toBe(200);
    expect(await refundedPaise(buyer.paymentId)).toBe(40_000);
  });

  it("goes ahead while the void is pending when every seat is free, since no refund would move", async () => {
    const { host, cls, buyer } = await seedPendingVoid({ free: true });
    expect((await hostCancels(host, cls.appointmentId)).status).toBe(200);
    expect(await classStatus(cls.classId)).toBe("CANCELLED");
    expect(
      await prisma.refund.count({ where: { paymentId: buyer.paymentId } }),
    ).toBe(0);
  });
});

describe("a make-up skip", () => {
  it("waits for the verdict with no refund, then refunds the void's session once however often it is skipped", async () => {
    const { host, cls, buyer, voidId } = await seedPendingVoid();
    // The host offered a make-up for the voided session; no money moves for that.
    const source = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: voidId },
      select: { ordinal: true },
    });
    const makeUpAt = new Date(Date.now() + 7 * DAY_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: cls.appointmentId,
        ordinal: source.ordinal,
        startsAt: makeUpAt,
        endsAt: new Date(makeUpAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "SCHEDULED",
      },
    });
    const skip = () =>
      skipClassMakeUp({
        appointmentId: cls.appointmentId,
        sourceOccurrenceId: voidId,
        userId: buyer.userId,
      });

    await expect(skip()).rejects.toMatchObject({
      code: "MAKEUP_SKIP_WAITS_FOR_VERDICT",
      message: expect.stringContaining(
        "Its refund waits until it's settled; the report window closes ",
      ),
    });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);

    await confirmVoid(voidId);
    await skip();
    await skip();
    expect(await refundedPaise(buyer.paymentId)).toBe(20_000);
  });
});

/** A make-up for the void's ordinal starting `fromNowMs` from now, an hour long. */
async function offerMakeUp(
  host: { consultantProfileId: string },
  cls: { appointmentId: string },
  voidId: string,
  fromNowMs: number,
) {
  const { ordinal } = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: voidId },
    select: { ordinal: true },
  });
  const startsAt = new Date(Date.now() + fromNowMs);
  return prisma.appointmentOccurrence.create({
    data: {
      appointmentId: cls.appointmentId,
      ordinal,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
      isTentative: false,
      consultantProfileId: host.consultantProfileId,
      completionStatus: "SCHEDULED",
    },
    select: { id: true, ordinal: true },
  });
}

/** Rows the live-ordinal unique counts for one ordinal. */
const liveRowsFor = (appointmentId: string, ordinal: number) =>
  prisma.appointmentOccurrence.count({
    where: {
      appointmentId,
      ordinal,
      deletedAt: null,
      completionStatus: { notIn: ["RESCHEDULED", "CANCELLED", "VOIDED"] },
    },
  });

describe("ops correcting a pending void after a make-up was offered", () => {
  it("restores the session held and cancels its unstarted make-up, with no refund and one live row for the ordinal", async () => {
    const { host, cls, buyer, voidId } = await seedPendingVoid();
    const makeUp = await offerMakeUp(host, cls, voidId, 7 * DAY_MS);
    const since = new Date();

    await relabelHeld(voidId);

    expect(
      await prisma.appointmentOccurrence.findUniqueOrThrow({
        where: { id: voidId },
        select: { completionStatus: true, outcome: true },
      }),
    ).toEqual({ completionStatus: "COMPLETED", outcome: "HELD" });
    expect(
      await prisma.appointmentOccurrence.findUniqueOrThrow({
        where: { id: makeUp.id },
        select: { completionStatus: true, deletedAt: true },
      }),
    ).toMatchObject({
      completionStatus: "CANCELLED",
      deletedAt: expect.any(Date),
    });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);
    expect(await liveRowsFor(cls.appointmentId, makeUp.ordinal)).toBe(1);
    // Both sides hear that the make-up is no longer happening.
    const told = await prisma.notificationOutbox.findMany({
      where: {
        workflowId: "class-session-cancelled",
        createdAt: { gte: since },
      },
      select: { recipients: true },
    });
    const recipients = told.flatMap((r) => r.recipients);
    expect(recipients).toEqual(
      expect.arrayContaining([buyer.userId, host.userId]),
    );
  });

  it("still refuses the correction once the make-up has started", async () => {
    const { host, cls, voidId } = await seedPendingVoid();
    await offerMakeUp(host, cls, voidId, -10 * 60_000);
    await expect(relabelHeld(voidId)).rejects.toMatchObject({
      code: "OUTCOME_SETTLED",
    });
    expect(
      (
        await prisma.appointmentOccurrence.findUniqueOrThrow({
          where: { id: voidId },
          select: { completionStatus: true },
        })
      ).completionStatus,
    ).toBe("VOIDED");
  });
});

describe("a skip whose lock wait crosses the make-up's start", () => {
  it("refuses with MAKEUP_NOT_SKIPPABLE and refunds nothing", async () => {
    const { host, cls, buyer, voidId } = await seedPendingVoid();
    await confirmVoid(voidId);
    await offerMakeUp(host, cls, voidId, 1_500);
    let skipped: Promise<unknown> | undefined;
    // Something else holds the booking's lock until the make-up has started.
    await withAppointmentLock(cls.appointmentId, async () => {
      skipped = skipClassMakeUp({
        appointmentId: cls.appointmentId,
        sourceOccurrenceId: voidId,
        userId: buyer.userId,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    });
    await expect(skipped).rejects.toMatchObject({
      code: "MAKEUP_NOT_SKIPPABLE",
    });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);
  });
});

describe("a skip whose own reads under the lock cross the make-up's start", () => {
  it("refuses with MAKEUP_NOT_SKIPPABLE and refunds nothing", async () => {
    const { host, cls, buyer, voidId } = await seedPendingVoid();
    await confirmVoid(voidId);
    await offerMakeUp(host, cls, voidId, 1_500);
    // The lock is free; a read the skip awaits before it judges the make-up answers after the make-up began.
    mockSlowLedger.ms = 2_500;

    await expect(
      skipClassMakeUp({
        appointmentId: cls.appointmentId,
        sourceOccurrenceId: voidId,
        userId: buyer.userId,
      }),
    ).rejects.toMatchObject({ code: "MAKEUP_NOT_SKIPPABLE" });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);
  });
});
