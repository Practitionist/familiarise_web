/**
 * A host's conduct removal on real Postgres: the seat ends, the case opens, the
 * earnings are held and both Stream intents are written in one transaction, with
 * no refund; an instance that dies after the commit leaves the intents for the
 * sweep. An overturn refunds exactly what is still unrefunded on the seat and
 * unblocks; the 72-hour deadline refunds once; a free seat owes nothing and a
 * credit-funded seat is returned on the credits rail.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { seedUser } from "../seed";
import {
  seedSeatBuyer,
  seedWebinar,
  type SeededWebinar,
} from "./harness-seats";
import { refundOnRows, refundedPaise } from "./harness-refunds";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);

const mockFailHold = { next: false };
jest.mock("../../../lib/support/case-holds", () => {
  const actual = jest.requireActual("../../../lib/support/case-holds");
  return {
    ...actual,
    holdPaymentForCase: async (...args: unknown[]) => {
      if (mockFailHold.next) {
        mockFailHold.next = false;
        throw new Error("database went away mid-transaction");
      }
      return actual.holdPaymentForCase(...args);
    },
  };
});

const mockCall = {
  kickUser: jest.fn(async () => ({})),
  blockUser: jest.fn(async () => ({})),
  unblockUser: jest.fn(async () => ({})),
  updateCallMembers: jest.fn(async () => ({})),
  get: jest.fn(async () => ({ call: { ended_at: null } })),
};
const stream = { configured: false };
jest.mock("../../../lib/stream-client", () => ({
  ...jest.requireActual("../../../lib/stream-client"),
  isStreamConfigured: () => stream.configured,
  getStreamVideoClient: () => ({ video: { call: () => mockCall } }),
}));
jest.mock("../../../lib/stream/event-channel-service", () => ({
  ...jest.requireActual("../../../lib/stream/event-channel-service"),
  removeUsersFromEventChannel: jest.fn(async () => ({ failedUserIds: [] })),
}));

import { removeAttendeeForConduct } from "../../../lib/booking/conduct-removal";
import { performCaseAction } from "../../../lib/support/case-actions";
import { sweepConductRemovalDeadlines } from "../../../lib/support/conduct-removal-case";
import { redriveAccessRevocation } from "../../../lib/stream/access-revocation";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";

const refundDoor = refundBookingPayment as jest.Mock;
const HOUR_MS = 3_600_000;
const SEAT = 100_000;

async function seatBuyer(
  webinar: SeededWebinar,
  pay: { amount: number; intent?: string } | null,
) {
  const buyer = await seedSeatBuyer();
  const payment = pay
    ? await prisma.payment.create({
        data: {
          amount: BigInt(pay.amount),
          originalAmount: BigInt(SEAT),
          paymentMethod: pay.intent ? "credits" : "card",
          paymentIntent: pay.intent ?? `order_dbtier_${randomUUID()}`,
          paymentGateway: "RAZORPAY",
          paymentStatus: "SUCCEEDED",
          userId: buyer.userId,
          appointmentId: webinar.appointmentId,
          isMockPayment: true,
          expiresAt: null,
          ...(pay.amount > 0
            ? {
                legs: {
                  create: [{ source: "CARD", amountPaise: BigInt(pay.amount) }],
                },
              }
            : {}),
        },
      })
    : null;
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "CONFIRMED",
      paymentId: payment?.id ?? null,
    },
  });
  return { userId: buyer.userId, payment };
}

async function paidSeat() {
  const webinar = await seedWebinar({ capacity: 10, price: SEAT });
  const seat = await seatBuyer(webinar, { amount: SEAT });
  const payment = seat.payment!;
  const earning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: webinar.host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(SEAT),
      platformFeePaise: BigInt(20_000),
      consultantSharePaise: BigInt(80_000),
      cycleOrdinal: 0,
      status: "PENDING",
      holdUntil: null,
    },
  });
  return { webinar, ...seat, payment, earningId: earning.id };
}

const remove = (webinar: SeededWebinar, userId: string) =>
  removeAttendeeForConduct({
    appointmentId: webinar.appointmentId,
    targetUserId: userId,
    actorUserId: webinar.host.userId,
    reason: "HARASSMENT",
    note: "Abusive messages in chat",
  });

async function overturn(caseId: string) {
  const staff = await seedUser("STAFF");
  const { updatedAt } = await prisma.supportCase.findUniqueOrThrow({
    where: { id: caseId },
    select: { updatedAt: true },
  });
  await performCaseAction(
    caseId,
    { userId: staff.userId, role: "STAFF", freshSession: true },
    {
      action: "DECIDE",
      clientActionId: randomUUID(),
      expectedUpdatedAt: updatedAt.toISOString(),
      outcome: "OVERTURNED",
      explanation: "The recording shows no harassment.",
    },
  );
}

const intents = (appointmentId: string, userId: string) =>
  prisma.streamRevocationRetry.findMany({
    where: { planId: appointmentId, userId },
    select: {
      kind: true,
      status: true,
      nextRetryAt: true,
      attempts: true,
      createdAt: true,
    },
    orderBy: { kind: "asc" },
  });

beforeEach(() => {
  stream.configured = false;
  jest.clearAllMocks();
  refundDoor.mockReset();
  refundDoor.mockImplementation(refundOnRows);
});

describe("removal", () => {
  it("ends the seat, opens the case, holds the earnings and writes both intents in one commit; nothing is refunded", async () => {
    const { webinar, userId, payment, earningId } = await paidSeat();

    // Stream is unreachable after the commit: the intents must outlive it.
    const removed = await remove(webinar, userId);
    expect(removed?.earningsHeld).toBe(true);

    const seat = await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId },
      select: { status: true },
    });
    expect(seat.status).toBe("CANCELLED");
    const supportCase = await prisma.supportCase.findUniqueOrThrow({
      where: { id: removed!.caseId },
      include: { events: true },
    });
    expect(supportCase).toMatchObject({
      category: "CONDUCT_REMOVAL",
      requesterUserId: userId,
      submitterUserId: userId,
      appointmentId: webinar.appointmentId,
    });
    expect(supportCase.description).toContain("Harassing or abusing others");
    expect(supportCase.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "CREATED",
          actorId: webinar.host.userId,
        }),
        expect.objectContaining({ kind: "HOLD_APPLIED", toValue: payment.id }),
      ]),
    );
    const earning = await prisma.consultantEarnings.findUniqueOrThrow({
      where: { id: earningId },
      select: { status: true },
    });
    expect(earning.status).toBe("HELD");
    expect(await refundedPaise(payment.id)).toBe(0);
    expect(refundDoor).not.toHaveBeenCalled();
    expect(
      (await intents(webinar.appointmentId, userId)).map((r) => [
        r.kind,
        r.status,
      ]),
    ).toEqual([
      ["SEAT_ACCESS_REVOKE", "PENDING"],
      ["CONDUCT_CALL_BLOCK", "PENDING"],
    ]);

    // The sweep's redrive of the surviving block intent kicks and blocks in each open room.
    stream.configured = true;
    await prisma.appointmentOccurrence
      .findFirstOrThrow({
        where: { appointmentId: webinar.appointmentId },
      })
      .then((occurrence) =>
        prisma.meeting.create({
          data: {
            streamCallId: `call-${randomUUID()}`,
            appointmentOccurrenceId: occurrence.id,
          },
        }),
      );
    const [block] = (await intents(webinar.appointmentId, userId)).filter(
      (r) => r.kind === "CONDUCT_CALL_BLOCK",
    );
    expect(
      await redriveAccessRevocation({
        kind: "CONDUCT_CALL_BLOCK",
        userId,
        planId: webinar.appointmentId,
        planType: null,
        counterpartUserId: null,
        createdAt: block.createdAt,
      }),
    ).toBeNull();
    expect(mockCall.kickUser).toHaveBeenCalledWith({
      user_id: userId,
      block: true,
    });
  });

  it("rolls back the seat, the case and the intents together when a step inside fails", async () => {
    const { webinar, userId } = await paidSeat();
    mockFailHold.next = true;

    await expect(remove(webinar, userId)).rejects.toThrow(/went away/);

    const seat = await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId },
      select: { status: true },
    });
    expect(seat.status).toBe("CONFIRMED");
    expect(
      await prisma.supportCase.count({
        where: {
          appointmentId: webinar.appointmentId,
          requesterUserId: userId,
        },
      }),
    ).toBe(0);
    expect(await intents(webinar.appointmentId, userId)).toEqual([]);
  });
});

describe("overturn", () => {
  it("refunds exactly the unrefunded remainder (₹1,000 less ₹250 sent; a failed ₹100 does not count) and unblocks", async () => {
    const { webinar, userId, payment } = await paidSeat();
    await prisma.refund.createMany({
      data: [
        {
          paymentId: payment.id,
          amountPaise: BigInt(25_000),
          status: "SUCCEEDED",
          paymentGateway: "RAZORPAY",
          refundId: `rfnd_dbtier_${randomUUID()}`,
        },
        {
          paymentId: payment.id,
          amountPaise: BigInt(10_000),
          status: "FAILED",
          paymentGateway: "RAZORPAY",
          refundId: `rfnd_dbtier_${randomUUID()}`,
        },
      ],
    });
    const removed = await remove(webinar, userId);
    stream.configured = true;
    await prisma.meeting.create({
      data: {
        streamCallId: `call-${randomUUID()}`,
        appointmentOccurrenceId: (
          await prisma.appointmentOccurrence.findFirstOrThrow({
            where: { appointmentId: webinar.appointmentId },
          })
        ).id,
      },
    });

    await overturn(removed!.caseId);

    expect(await refundedPaise(payment.id)).toBe(100_000);
    const sent = await prisma.refund.findMany({
      where: { paymentId: payment.id, dedupeKey: { not: null } },
      select: { amountPaise: true, dedupeKey: true },
    });
    expect(sent).toEqual([
      {
        amountPaise: BigInt(75_000),
        dedupeKey: `conduct-removal:${removed!.caseId}:pay:${payment.id}`,
      },
    ]);
    const marker = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { refundOwedKey: true },
    });
    expect(marker.refundOwedKey).toBeNull();
    expect(mockCall.unblockUser).toHaveBeenCalledWith({ user_id: userId });
    const block = (await intents(webinar.appointmentId, userId)).find(
      (r) => r.kind === "CONDUCT_CALL_BLOCK",
    );
    expect(block?.status).toBe("SUCCEEDED");
  });

  it("refunds nothing for a free seat and restores credits for a credit-funded seat", async () => {
    const webinar = await seedWebinar({ capacity: 10, price: 0 });
    const free = await seatBuyer(webinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
    });
    await prisma.payment.update({
      where: { id: free.payment!.id },
      data: { originalAmount: BigInt(0) },
    });
    const freeRemoval = await remove(webinar, free.userId);
    await overturn(freeRemoval!.caseId);
    expect(refundDoor).not.toHaveBeenCalled();
    expect(
      await prisma.payment.findUniqueOrThrow({
        where: { id: free.payment!.id },
        select: { refundOwedKey: true },
      }),
    ).toEqual({ refundOwedKey: null });

    const paidWebinar = await seedWebinar({ capacity: 10, price: SEAT });
    const credit = await seatBuyer(paidWebinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
    });
    refundDoor.mockImplementation(async () => ({
      refundId: `rf_${randomUUID()}`,
      amountRefundedPaise: 0,
      rail: "CREDITS",
      status: "SUCCEEDED",
    }));
    const creditRemoval = await remove(paidWebinar, credit.userId);
    await overturn(creditRemoval!.caseId);
    const key = `conduct-removal:${creditRemoval!.caseId}:pay:${credit.payment!.id}`;
    expect(refundDoor.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of refundDoor.mock.calls) {
      // The credits rail restores in full: no amount, under the removal's key.
      expect(args).toMatchObject({
        paymentId: credit.payment!.id,
        dedupeKey: key,
      });
      expect(args).not.toHaveProperty("amountPaise");
    }
  });
});

describe("the 72-hour deadline", () => {
  it("refunds the unrefunded balance once, at 72 hours and not before", async () => {
    const { webinar, userId, payment } = await paidSeat();
    const removed = await remove(webinar, userId);
    const removedAt = (
      await prisma.supportCase.findUniqueOrThrow({
        where: { id: removed!.caseId },
        select: { createdAt: true },
      })
    ).createdAt.getTime();
    const errors: string[] = [];

    await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(removedAt + 71 * HOUR_MS),
      errors,
    });
    expect(await refundedPaise(payment.id)).toBe(0);

    const at72 = new Date(removedAt + 72 * HOUR_MS);
    const first = await sweepConductRemovalDeadlines({
      limit: 50,
      now: at72,
      errors,
    });
    const again = await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(at72.getTime() + HOUR_MS),
      errors,
    });

    expect(errors).toEqual([]);
    expect(first.lapsed).toBeGreaterThanOrEqual(1);
    expect(await refundedPaise(payment.id)).toBe(SEAT);
    expect(
      await prisma.supportCaseEvent.count({
        where: { caseId: removed!.caseId, kind: "REMOVAL_REVIEW_LAPSED" },
      }),
    ).toBe(1);
    const lapsedAgain = await prisma.supportCase.count({
      where: {
        id: removed!.caseId,
        events: { some: { kind: "REMOVAL_REVIEW_LAPSED" } },
      },
    });
    expect(lapsedAgain).toBe(1);
    expect(again.lapsed).toBe(0);
  });
});
