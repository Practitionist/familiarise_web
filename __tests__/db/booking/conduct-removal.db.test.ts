/** A conduct removal on real Postgres: one commit, no refund at removal, refund-first overturns, the 72-hour lapse and its edge cases. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { rowId, seedUser } from "../seed";
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

/** The maintenance flag lives in Redis, which the database tier does not run. */
jest.mock("../../../lib/backoffice/maintenance-gate", () => ({
  ...jest.requireActual("../../../lib/backoffice/maintenance-gate"),
  assertMoneyDoorsOpen: async () => undefined,
}));
jest.mock("../../../lib/data/public-cache", () => ({
  ...jest.requireActual("../../../lib/data/public-cache"),
  purgeReviewSurfaces: jest.fn(),
}));
const mockFailHold = { next: false };
const mockDuringRemoval = { run: null as null | (() => void) };
const mockDieAfterCommit = { next: false };
jest.mock("../../../lib/stream/access-revocation", () => {
  const actual = jest.requireActual("../../../lib/stream/access-revocation");
  return {
    ...actual,
    syncConductCallBlock: async (...args: unknown[]) => {
      if (mockDieAfterCommit.next) {
        mockDieAfterCommit.next = false;
        throw new Error("instance died after the removal commit");
      }
      return actual.syncConductCallBlock(...args);
    },
  };
});
jest.mock("../../../lib/support/case-holds", () => {
  const actual = jest.requireActual("../../../lib/support/case-holds");
  return {
    ...actual,
    holdPaymentForCase: async (...args: unknown[]) => {
      const during = mockDuringRemoval.run;
      mockDuringRemoval.run = null;
      during?.();
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

// A rejoin goes through the real checkout; its edges are not under test here.
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
jest.mock("../../../lib/payments/checkout/free-seat-notice", () => ({
  ...jest.requireActual("../../../lib/payments/checkout/free-seat-notice"),
  notifyFreeSeatRegistered: jest.fn(async () => undefined),
}));

import { removeAttendeeForConduct } from "../../../lib/booking/conduct-removal";
import { handleCheckout } from "../../../lib/payments/checkout";
import {
  liftSeatRemovalAsOrganiser,
  liftSeatRemovalTx,
} from "../../../lib/booking/seat-removal-lift";
import { conductRemovalStands } from "../../../lib/support/conduct-removal-state";
import { isForeignKeyViolation } from "../../../lib/db/pg-errors";
import { performCaseAction } from "../../../lib/support/case-actions";
import { sweepConductRemovalDeadlines } from "../../../lib/support/conduct-removal-case";
import { redriveAccessRevocation } from "../../../lib/stream/access-revocation";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";

const refundDoor = refundBookingPayment as jest.Mock;
const HOUR_MS = 3_600_000;
const SEAT = 100_000;

async function seatBuyer(
  webinar: SeededWebinar,
  pay: { amount: number; intent?: string; listPaise?: number } | null,
) {
  const buyer = await seedSeatBuyer();
  const payment = pay
    ? await prisma.payment.create({
        data: {
          amount: BigInt(pay.amount),
          originalAmount: BigInt(pay.listPaise ?? SEAT),
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

async function paidSeat(price = SEAT) {
  const webinar = await seedWebinar({ capacity: 10, price });
  const seat = await seatBuyer(webinar, { amount: price, listPaise: price });
  const payment = seat.payment!;
  const earning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: webinar.host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(price),
      platformFeePaise: BigInt(price / 5),
      consultantSharePaise: BigInt(price - price / 5),
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
    authorizeTx: async () => true,
    note: "Abusive messages in chat",
  });

type Actor = { userId: string; role: "STAFF" | "ADMIN"; freshSession: true };
const actor = async (role: "STAFF" | "ADMIN"): Promise<Actor> => ({
  userId: (await seedUser(role)).userId,
  role,
  freshSession: true,
});
const version = async (caseId: string) =>
  (
    await prisma.supportCase.findUniqueOrThrow({
      where: { id: caseId },
      select: { updatedAt: true },
    })
  ).updatedAt.toISOString();

async function decide(
  caseId: string,
  by: Actor,
  outcome: "OVERTURNED" | "UPHELD",
) {
  return performCaseAction(caseId, by, {
    action: "DECIDE",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await version(caseId),
    outcome,
    explanation: "The recording settles it.",
  });
}

async function recommend(
  caseId: string,
  by: Actor,
  paymentId: string,
  paise: number,
) {
  const result = await performCaseAction(caseId, by, {
    action: "RECOMMEND_REFUND",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await version(caseId),
    paymentId,
    amountPaise: paise,
    reason: "Overturning the removal: return the seat",
    releaseSeat: false,
  });
  if (!("id" in result) || typeof result.id !== "string")
    throw new Error("no recommendation");
  return result.id;
}

async function review(
  caseId: string,
  by: Actor,
  recommendationId: string,
  approve: boolean,
  expectedRefundablePaise?: number,
) {
  return performCaseAction(caseId, by, {
    action: "REVIEW_REFUND",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await version(caseId),
    recommendationId,
    approve,
    reason: approve ? "The removal is overturned" : "Already refunded",
    ...(expectedRefundablePaise === undefined
      ? {}
      : { expectedRefundablePaise }),
  });
}

/** Moves the case's clock back, so its 72-hour deadline has already passed. */
const pastDeadline = (caseId: string) =>
  prisma.supportCase.update({
    where: { id: caseId },
    data: {
      createdAt: new Date(Date.now() - 73 * HOUR_MS),
      statutoryDueAt: new Date(Date.now() - HOUR_MS),
    },
  });

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

    // The instance dies right after the commit, before any Stream call.
    mockDieAfterCommit.next = true;
    await expect(remove(webinar, userId)).rejects.toThrow(/instance died/);

    const seat = await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId },
      select: { status: true },
    });
    expect(seat.status).toBe("CANCELLED");
    const supportCase = await prisma.supportCase.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, requesterUserId: userId },
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
    // The mark and its SEAT row roll back with the seat.
    expect(
      await prisma.appointmentParticipant.count({
        where: {
          appointmentId: webinar.appointmentId,
          userId,
          removedByUserId: { not: null },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.bookingStatusHistory.count({
        where: {
          entity: "SEAT",
          appointmentId: webinar.appointmentId,
          reason: "conduct_removal",
        },
      }),
    ).toBe(0);
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

describe("overturn: refund first, through the bounded door", () => {
  it("a staff overturn of a ₹6,000 seat waits for an admin to approve its refund, then records", async () => {
    const { webinar, userId, payment } = await paidSeat(600_000);
    const { caseId } = (await remove(webinar, userId))!;
    const staff = await actor("STAFF");
    const reviewer = await actor("STAFF");
    const admin = await actor("ADMIN");

    await expect(decide(caseId, staff, "OVERTURNED")).rejects.toMatchObject({
      code: "REFUND_FIRST",
    });
    const recommendationId = await recommend(
      caseId,
      staff,
      payment.id,
      600_000,
    );
    await expect(
      review(caseId, reviewer, recommendationId, true, 600_000),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(await refundedPaise(payment.id)).toBe(0);
    await expect(decide(caseId, staff, "OVERTURNED")).rejects.toBeTruthy();

    await review(caseId, admin, recommendationId, true, 600_000);
    expect(await refundedPaise(payment.id)).toBe(600_000);
    await expect(decide(caseId, staff, "OVERTURNED")).resolves.toMatchObject({
      outcome: "OVERTURNED",
    });
  });

  it("a staff overturn of a ₹4,000 seat refunds at once, counts in movedPaise, then records and unblocks", async () => {
    const { webinar, userId, payment } = await paidSeat(400_000);
    const { caseId } = (await remove(webinar, userId))!;
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
    const staff = await actor("STAFF");
    const reviewer = await actor("STAFF");

    const recommendationId = await recommend(
      caseId,
      staff,
      payment.id,
      400_000,
    );
    const reviewed = await review(
      caseId,
      reviewer,
      recommendationId,
      true,
      400_000,
    );
    expect(reviewed).toMatchObject({ movedPaise: 400_000 });
    expect(await refundedPaise(payment.id)).toBe(400_000);

    stream.configured = true;
    await decide(caseId, staff, "OVERTURNED");
    expect(mockCall.unblockUser).toHaveBeenCalledWith({ user_id: userId });
    const block = (await intents(webinar.appointmentId, userId)).find(
      (r) => r.kind === "CONDUCT_CALL_BLOCK",
    );
    expect(block?.status).toBe("SUCCEEDED");
  });

  it("a lapse refund that lands before the admin acts leaves the approval nothing to send", async () => {
    const { webinar, userId, payment } = await paidSeat(600_000);
    const { caseId } = (await remove(webinar, userId))!;
    const staff = await actor("STAFF");
    const admin = await actor("ADMIN");
    const recommendationId = await recommend(
      caseId,
      staff,
      payment.id,
      600_000,
    );

    await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(Date.now() + 73 * HOUR_MS),
      errors: [],
    });
    expect(await refundedPaise(payment.id)).toBe(600_000);

    await expect(
      review(caseId, admin, recommendationId, true, 0),
    ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_REFUNDABLE" });
    expect(await refundedPaise(payment.id)).toBe(600_000);
    await review(caseId, staff, recommendationId, false);
    await expect(decide(caseId, staff, "OVERTURNED")).resolves.toMatchObject({
      outcome: "OVERTURNED",
    });
  });

  it("an admin correcting an UPHELD removal refunds through the admin Refunds door first, then overturns", async () => {
    const { webinar, userId, payment } = await paidSeat(100_000);
    const { caseId } = (await remove(webinar, userId))!;
    const upheld = await decide(caseId, await actor("STAFF"), "UPHELD");
    const admin = await actor("ADMIN");
    const correct = async () =>
      performCaseAction(caseId, admin, {
        action: "DECIDE",
        clientActionId: randomUUID(),
        expectedUpdatedAt: await version(caseId),
        outcome: "OVERTURNED",
        explanation: "The recording shows no harassment.",
        supersedesDecisionId: rowId(upheld),
      });

    await expect(correct()).rejects.toMatchObject({
      code: "REFUND_FIRST",
      message: expect.stringContaining(
        `/dashboard/admin/payments/${payment.id}?refund=1`,
      ),
    });
    // What Issue refund on the payment page sends (POST /api/admin/refunds/issue, no amount).
    await refundBookingPayment({
      paymentId: payment.id,
      reason: "ops refund: conduct removal overturned",
      initiatedByUserId: admin.userId,
      dedupeKey: `ops:${randomUUID()}`,
      keepSeatIfPartial: true,
      settlesOwedByHand: true,
    });
    expect(await refundedPaise(payment.id)).toBe(100_000);

    await expect(correct()).resolves.toMatchObject({ outcome: "OVERTURNED" });
  });

  it("a free seat owes nothing, so its overturn records at once", async () => {
    const webinar = await seedWebinar({ capacity: 10, price: 0 });
    const free = await seatBuyer(webinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
      listPaise: 0,
    });
    const { caseId } = (await remove(webinar, free.userId))!;
    const decision = await decide(caseId, await actor("STAFF"), "OVERTURNED");
    expect(refundDoor).not.toHaveBeenCalled();
    // The learner hears of the decision as a required removed-seat notice.
    const notice = await prisma.notificationOutbox.findFirstOrThrow({
      where: { entityRef: `decision:${rowId(decision)}` },
      select: { recipients: true, payload: true },
    });
    expect(notice.recipients).toContain(free.userId);
    expect(notice.payload).toMatchObject({ requiredNotice: "SEAT_RELEASED" });
  });
});

describe("rejoining after a conduct removal", () => {
  /** A free webinar seat removed for conduct, with the checkout body its learner would send. */
  async function removedFreeSeat() {
    const webinar = await seedWebinar({ capacity: 10, price: 0 });
    const free = await seatBuyer(webinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
      listPaise: 0,
    });
    const { caseId } = (await remove(webinar, free.userId))!;
    const rejoin = () =>
      handleCheckout(
        {
          appointmentType: "WEBINAR",
          planId: webinar.planId,
          eventId: webinar.webinarId,
          paymentGateway: "RAZORPAY",
          clientIdempotencyKey: `rejoin-${randomUUID()}`,
          consumerStateCode: "29",
        },
        free.userId,
      );
    return { webinar, userId: free.userId, caseId, rejoin };
  }
  const liftAsStaff = async (webinar: SeededWebinar, userId: string) => {
    const staff = await actor("STAFF");
    return prisma.$transaction((tx) =>
      liftSeatRemovalTx(tx, {
        appointmentId: webinar.appointmentId,
        userId,
        actorUserId: staff.userId,
        door: "staff",
      }),
    );
  };

  it("an unmarked standing removal still stands, refuses the rejoin, and staff lift it to let the learner back", async () => {
    const { webinar, userId, rejoin } = await removedFreeSeat();
    // A removal from before the mark existed: the case stands, the seat carries no mark.
    await prisma.appointmentParticipant.updateMany({
      where: { appointmentId: webinar.appointmentId, userId },
      data: { removedByUserId: null },
    });
    expect(await conductRemovalStands(webinar.appointmentId, userId)).toBe(
      true,
    );
    await expect(rejoin()).rejects.toMatchObject({
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/left this event/),
    });

    const lifted = await liftAsStaff(webinar, userId);
    expect(lifted).toMatchObject({ conduct: true, kind: "CONDUCT" });
    expect(await conductRemovalStands(webinar.appointmentId, userId)).toBe(
      false,
    );
    await expect(rejoin()).resolves.toMatchObject({ success: true });
  });

  it("a remover's account cannot be deleted while their mark stands, and can once it is lifted", async () => {
    const webinar = await seedWebinar({ capacity: 10, price: 0 });
    const free = await seatBuyer(webinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
      listPaise: 0,
    });
    // A remover with no other rows, so the only thing holding the account is the mark.
    const remover = await seedUser("STAFF");
    await removeAttendeeForConduct({
      appointmentId: webinar.appointmentId,
      targetUserId: free.userId,
      actorUserId: remover.userId,
      reason: "HARASSMENT",
      authorizeTx: async () => true,
      note: null,
    });
    // History and case-event actors are SET NULL; only the seat's mark holds the account.
    const deleteRemover = () =>
      prisma.user
        .delete({ where: { id: remover.userId } })
        .then(() => undefined);

    const refused = await deleteRemover().catch((error: unknown) => error);
    expect(isForeignKeyViolation(refused)).toBe(true);
    expect(
      await prisma.appointmentParticipant.findFirstOrThrow({
        where: { appointmentId: webinar.appointmentId, userId: free.userId },
        select: { removedByUserId: true },
      }),
    ).toEqual({ removedByUserId: remover.userId });

    await liftAsStaff(webinar, free.userId);
    await expect(deleteRemover()).resolves.toBeUndefined();
  });

  it("marks the seat with its remover and refuses the rejoin while the removal stands, even upheld", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    const seat = await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId },
      select: { id: true, removedByUserId: true },
    });
    expect(seat.removedByUserId).toBe(webinar.host.userId);
    expect(
      await prisma.bookingStatusHistory.findFirst({
        where: { entity: "SEAT", entityId: seat.id },
        select: { reason: true, actorUserId: true, toStatus: true },
      }),
    ).toEqual({
      reason: "conduct_removal",
      actorUserId: webinar.host.userId,
      toStatus: "CANCELLED",
    });
    await expect(rejoin()).rejects.toMatchObject({
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/organiser removed you/),
    });
    await decide(caseId, await actor("STAFF"), "UPHELD");
    await expect(rejoin()).rejects.toMatchObject({
      code: "SEAT_REBUY_UNSUPPORTED",
    });
  });

  it("a staff lift of an upheld removal leaves the verdict, re-arms the call block to unblock, and the rejoin succeeds", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    const upheld = await decide(caseId, await actor("STAFF"), "UPHELD");

    const lifted = await liftAsStaff(webinar, userId);
    expect(lifted).toMatchObject({ conduct: true, rejoinPath: "REGISTER" });
    expect(await conductRemovalStands(webinar.appointmentId, userId)).toBe(
      false,
    );
    // The upheld finding stays in force: lifting is not a decision.
    expect(
      await prisma.supportCaseDecision.findMany({
        where: { caseId },
        select: {
          id: true,
          outcome: true,
          supersededBy: { select: { id: true } },
        },
      }),
    ).toEqual([{ id: rowId(upheld), outcome: "UPHELD", supersededBy: null }]);
    expect(
      (await intents(webinar.appointmentId, userId)).filter(
        (r) => r.kind === "CONDUCT_CALL_BLOCK",
      ),
    ).toHaveLength(1);

    await expect(rejoin()).resolves.toMatchObject({ success: true });
    expect(
      await prisma.appointmentParticipant.findFirstOrThrow({
        where: { appointmentId: webinar.appointmentId, userId },
        select: { status: true, removedByUserId: true },
      }),
    ).toEqual({ status: "CONFIRMED", removedByUserId: null });
  });

  it("a decided case is closed by the second removal and a fresh case opens, the old decision intact on the old case", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    const upheld = await decide(caseId, await actor("STAFF"), "UPHELD");
    await liftAsStaff(webinar, userId);
    await expect(rejoin()).resolves.toMatchObject({ success: true });

    const again = await remove(webinar, userId);

    expect(again?.caseId).toBeDefined();
    expect(again?.caseId).not.toBe(caseId);
    const old = await prisma.supportCase.findUniqueOrThrow({
      where: { id: caseId },
      select: {
        status: true,
        closedAt: true,
        decisions: {
          select: {
            id: true,
            outcome: true,
            supersededBy: { select: { id: true } },
          },
        },
        events: {
          where: { kind: "STATUS_CHANGED", toValue: "CLOSED" },
          select: { fromValue: true, note: true },
        },
      },
    });
    expect(old.status).toBe("CLOSED");
    expect(old.closedAt).not.toBeNull();
    expect(old.decisions).toEqual([
      { id: rowId(upheld), outcome: "UPHELD", supersededBy: null },
    ]);
    expect(old.events).toEqual([
      {
        fromValue: "RESOLVED",
        note: expect.stringContaining(again!.caseReference),
      },
    ]);
    const fresh = await prisma.supportCase.findUniqueOrThrow({
      where: { id: again!.caseId },
      select: {
        status: true,
        closedAt: true,
        statutoryDueAt: true,
        category: true,
        decisions: { select: { id: true } },
      },
    });
    expect(fresh).toMatchObject({
      status: "OPEN",
      closedAt: null,
      category: "CONDUCT_REMOVAL",
      decisions: [],
    });
    expect(fresh.statutoryDueAt!.getTime()).toBeGreaterThan(
      Date.now() + 71 * HOUR_MS,
    );
    expect(await conductRemovalStands(webinar.appointmentId, userId)).toBe(
      true,
    );
    await expect(rejoin()).rejects.toMatchObject({
      code: "SEAT_REBUY_UNSUPPORTED",
    });
  });

  it("an undecided case is joined by the second removal: one case, its status kept, its deadline restarted", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    await liftAsStaff(webinar, userId);
    await expect(rejoin()).resolves.toMatchObject({ success: true });
    const before = await prisma.supportCase.findUniqueOrThrow({
      where: { id: caseId },
      select: { statutoryDueAt: true, messageSeq: true, status: true },
    });

    await expect(remove(webinar, userId)).resolves.toMatchObject({ caseId });

    expect(
      await prisma.supportCase.count({
        where: {
          appointmentId: webinar.appointmentId,
          requesterUserId: userId,
        },
      }),
    ).toBe(1);
    const joined = await prisma.supportCase.findUniqueOrThrow({
      where: { id: caseId },
      select: {
        status: true,
        statutoryDueAt: true,
        messageSeq: true,
        events: {
          where: { kind: "REOPENED" },
          select: { actorId: true, note: true },
        },
      },
    });
    expect(joined.status).toBe(before.status);
    expect(joined.messageSeq).toBe(before.messageSeq + 1);
    expect(joined.statutoryDueAt!.getTime()).toBeGreaterThan(
      before.statutoryDueAt!.getTime(),
    );
    expect(joined.events).toEqual([
      {
        actorId: webinar.host.userId,
        note: expect.stringMatching(/removed .* again/i),
      },
    ]);
    // The lift followed the first removal, not this one, so the new removal stands.
    expect(await conductRemovalStands(webinar.appointmentId, userId)).toBe(
      true,
    );
    await expect(rejoin()).rejects.toMatchObject({
      code: "SEAT_REBUY_UNSUPPORTED",
    });
  });

  it("a joined removal's lapse waits 72 hours from the second removal, not the first", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    await liftAsStaff(webinar, userId);
    await expect(rejoin()).resolves.toMatchObject({ success: true });
    // The first removal is long past its own deadline.
    await prisma.supportCase.update({
      where: { id: caseId },
      data: { createdAt: new Date(Date.now() - 100 * HOUR_MS) },
    });

    await remove(webinar, userId);

    const sweep = () =>
      sweepConductRemovalDeadlines({ limit: 10, now: new Date(), errors: [] });
    expect(await sweep()).toEqual({ lapsed: 0 });
    await prisma.supportCase.update({
      where: { id: caseId },
      data: { statutoryDueAt: new Date(Date.now() - HOUR_MS) },
    });
    expect(await sweep()).toEqual({ lapsed: 1 });
  });

  it("an appeal of the first case's decision, overturned, does not touch the fresh case", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    const upheld = await decide(caseId, await actor("STAFF"), "UPHELD");
    await liftAsStaff(webinar, userId);
    await expect(rejoin()).resolves.toMatchObject({ success: true });
    const again = (await remove(webinar, userId))!;
    const appeal = await prisma.supportCase.create({
      data: {
        referenceNumber: `AP-${randomUUID().slice(0, 12)}`,
        title: "Appeal of a platform decision",
        description: "I did nothing wrong the first time.",
        category: "SERVICE_APPEAL",
        requesterUserId: userId,
        submitterUserId: userId,
        ownershipScope: "PERSONAL",
        scopeKey: `CASE_DECISION:${rowId(upheld)}`,
        appealOfDecisionId: rowId(upheld),
        activeChannel: "HUMAN",
        priority: "HIGH",
        receivedAt: new Date(),
      },
    });

    await decide(appeal.id, await actor("ADMIN"), "OVERTURNED");

    expect(
      await prisma.supportCase.findUniqueOrThrow({
        where: { id: again.caseId },
        select: { status: true, decisions: { select: { id: true } } },
      }),
    ).toEqual({ status: "OPEN", decisions: [] });
    expect(
      await prisma.appointmentParticipant.findFirstOrThrow({
        where: { appointmentId: webinar.appointmentId, userId },
        select: { removedByUserId: true },
      }),
    ).toEqual({ removedByUserId: webinar.host.userId });
    expect(await conductRemovalStands(webinar.appointmentId, userId)).toBe(
      true,
    );
    await expect(rejoin()).rejects.toMatchObject({
      code: "SEAT_REBUY_UNSUPPORTED",
    });
  });

  it("closing a decided case for a second removal keeps its payout holds while a refund recommendation awaits review", async () => {
    const { webinar, userId, payment, earningId } = await paidSeat();
    const { caseId } = (await remove(webinar, userId))!;
    const staff = await actor("STAFF");
    await decide(caseId, staff, "UPHELD");
    // After the verdict support holds the payout again and recommends a refund for review.
    await performCaseAction(caseId, staff, {
      action: "APPLY_HOLD",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await version(caseId),
      paymentId: payment.id,
      reason: "Checking the payout before the refund review",
    });
    const recommendationId = await recommend(caseId, staff, payment.id, 10_000);
    // Support lets the learner back on their paid seat by hand.
    await prisma.appointmentParticipant.updateMany({
      where: { appointmentId: webinar.appointmentId, userId },
      data: { status: "CONFIRMED", removedByUserId: null },
    });

    const again = (await remove(webinar, userId))!;

    expect(again.caseId).not.toBe(caseId);
    expect(
      await prisma.supportCase.findUniqueOrThrow({
        where: { id: caseId },
        select: { status: true },
      }),
    ).toEqual({ status: "CLOSED" });
    // The hold the open recommendation relies on is still in force on the closed case.
    expect(
      await prisma.earningsHold.count({
        where: {
          consultantEarningsId: earningId,
          sourceRef: caseId,
          releasedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.supportFinancialRecommendation.findUniqueOrThrow({
        where: { id: recommendationId },
        select: { decidedAt: true, voidedAt: true },
      }),
    ).toEqual({ decidedAt: null, voidedAt: null });
  });

  it("a lift started while a removal holds the event's lock waits for it, so it sees the removal it would lift", async () => {
    const webinar = await seedWebinar({ capacity: 10, price: 0 });
    const free = await seatBuyer(webinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
      listPaise: 0,
    });
    let lift: Promise<unknown> | null = null;
    // Inside the removal's transaction: the host tries Allow back on the same seat.
    mockDuringRemoval.run = () => {
      lift = liftSeatRemovalAsOrganiser({
        appointmentId: webinar.appointmentId,
        userId: free.userId,
        actorUserId: webinar.host.userId,
      }).catch((error: unknown) => error);
    };

    await remove(webinar, free.userId);

    // It ran after the removal committed: it found a standing conduct removal, not a live seat.
    expect(await lift).toMatchObject({ code: "LIFT_NOT_ALLOWED" });
    expect(
      await prisma.bookingStatusHistory.count({
        where: {
          entity: "SEAT",
          appointmentId: webinar.appointmentId,
          reason: "block_lifted",
        },
      }),
    ).toBe(0);
  });

  it("an overturn from the case panel lifts the mark too, so the rejoin succeeds", async () => {
    const { webinar, userId, caseId, rejoin } = await removedFreeSeat();
    await decide(caseId, await actor("STAFF"), "OVERTURNED");

    expect(
      await prisma.bookingStatusHistory.count({
        where: {
          entity: "SEAT",
          appointmentId: webinar.appointmentId,
          reason: "block_lifted",
        },
      }),
    ).toBe(1);
    await expect(rejoin()).resolves.toMatchObject({ success: true });
    // A second lift finds nothing to lift.
    await expect(liftAsStaff(webinar, userId)).rejects.toMatchObject({
      code: "REMOVAL_ALREADY_LIFTED",
    });
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

  it("refunds exactly the unrefunded remainder: ₹1,000 less ₹250 sent, a failed ₹100 not counted", async () => {
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
    const { caseId } = (await remove(webinar, userId))!;
    await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(Date.now() + 73 * HOUR_MS),
      errors: [],
    });
    const sent = await prisma.refund.findMany({
      where: { paymentId: payment.id, dedupeKey: { not: null } },
      select: { amountPaise: true, dedupeKey: true },
    });
    expect(sent.map((r) => [Number(r.amountPaise), r.dedupeKey])).toEqual([
      [75_000, `conduct-removal:${caseId}:pay:${payment.id}`],
    ]);
  });

  it("restores a credit-funded seat on the credits rail, under the removal's key", async () => {
    const webinar = await seedWebinar({ capacity: 10, price: SEAT });
    const credit = await seatBuyer(webinar, {
      amount: 0,
      intent: `free_${randomUUID()}`,
    });
    refundDoor.mockImplementation(async () => ({
      refundId: `rf_${randomUUID()}`,
      amountRefundedPaise: 0,
      rail: "CREDITS",
      status: "SUCCEEDED",
    }));
    const { caseId } = (await remove(webinar, credit.userId))!;
    await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(Date.now() + 73 * HOUR_MS),
      errors: [],
    });
    const ours = refundDoor.mock.calls.filter(
      ([args]) =>
        (args as { paymentId: string }).paymentId === credit.payment!.id,
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const [args] of ours) {
      expect(args).toMatchObject({
        dedupeKey: `conduct-removal:${caseId}:pay:${credit.payment!.id}`,
      });
      expect(args).not.toHaveProperty("amountPaise");
    }
  });

  it("still refunds when support upholds after the deadline: a late decision does not cancel the promise", async () => {
    const { webinar, userId, payment } = await paidSeat();
    const { caseId } = (await remove(webinar, userId))!;
    await pastDeadline(caseId);

    await decide(caseId, await actor("STAFF"), "UPHELD");
    await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(),
      errors: [],
    });

    expect(await refundedPaise(payment.id)).toBe(SEAT);
  });

  it("refunds nothing when support upholds in time", async () => {
    const { webinar, userId, payment } = await paidSeat();
    const { caseId } = (await remove(webinar, userId))!;
    await prisma.supportCase.update({
      where: { id: caseId },
      data: {
        createdAt: new Date(Date.now() - 71 * HOUR_MS),
        statutoryDueAt: new Date(Date.now() + HOUR_MS),
      },
    });
    await decide(caseId, await actor("STAFF"), "UPHELD");
    await sweepConductRemovalDeadlines({
      limit: 50,
      now: new Date(Date.now() + 2 * HOUR_MS),
      errors: [],
    });
    expect(await refundedPaise(payment.id)).toBe(0);
  });
});
