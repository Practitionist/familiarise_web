/** The conduct removal races on real Postgres: overlapping lapses, many rooms, stale Stream writes, one report a run, a revoked co-host. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { lockCaseRow, raceBehindLock, seedUser } from "../seed";
import { sessionUser } from "./harness-edges";
import {
  seedSeatBuyer,
  seedWebinar,
  type SeededWebinar,
} from "./harness-seats";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-edges").authHelpersMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
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
jest.mock("../../../lib/observability/report", () => ({
  ...jest.requireActual("../../../lib/observability/report"),
  reportSentryError: jest.fn(),
}));
const mockBeforeLock = { run: null as null | (() => Promise<unknown>) };
jest.mock("../../../utils/appointmentlock", () => {
  const actual = jest.requireActual("../../../utils/appointmentlock");
  return {
    ...actual,
    withAppointmentLock: async (...args: unknown[]) => {
      const run = mockBeforeLock.run;
      mockBeforeLock.run = null;
      if (run) await run();
      return actual.withAppointmentLock(...args);
    },
  };
});

const mockCall = {
  kickUser: jest.fn(async (_req: { user_id: string }) => ({})),
  blockUser: jest.fn(async () => ({})),
  unblockUser: jest.fn(async (_req: { user_id: string }) => ({})),
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
import { handleGroupConductRemoval } from "../../../lib/api/participants/group-participants-route";
import { performCaseAction } from "../../../lib/support/case-actions";
import { sweepConductRemovalDeadlines } from "../../../lib/support/conduct-removal-case";
import { redriveAccessRevocation } from "../../../lib/stream/access-revocation";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";
import { reportSentryError } from "../../../lib/observability/report";

const refundDoor = refundBookingPayment as jest.Mock;
const HOUR_MS = 3_600_000;

async function seat(webinar: SeededWebinar, paid: boolean) {
  const buyer = await seedSeatBuyer();
  const amount = BigInt(paid ? 100_000 : 0);
  const payment = await prisma.payment.create({
    data: {
      amount,
      originalAmount: amount,
      paymentMethod: paid ? "card" : "credits",
      paymentIntent: paid
        ? `order_dbtier_${randomUUID()}`
        : `free_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: webinar.appointmentId,
      isMockPayment: true,
      expiresAt: null,
      ...(paid
        ? { legs: { create: [{ source: "CARD", amountPaise: amount }] } }
        : {}),
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "CONFIRMED",
      paymentId: payment.id,
    },
  });
  return { userId: buyer.userId, payment };
}

async function removed(paid = false) {
  const webinar = await seedWebinar({
    capacity: 10,
    price: paid ? 100_000 : 0,
  });
  const { userId, payment } = await seat(webinar, paid);
  const result = await removeAttendeeForConduct({
    appointmentId: webinar.appointmentId,
    targetUserId: userId,
    actorUserId: webinar.host.userId,
    reason: "DISRUPTIVE",
    authorizeTx: async () => true,
    note: null,
  });
  return { webinar, userId, payment, caseId: result!.caseId };
}

async function openRooms(appointmentId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const occurrence = await prisma.appointmentOccurrence.create({
      data: {
        appointmentId,
        ordinal: 100 + i,
        startsAt: new Date(Date.now() + (i + 1) * 3 * HOUR_MS),
        endsAt: new Date(Date.now() + (i + 1) * 3 * HOUR_MS + HOUR_MS),
        isTentative: true,
      },
    });
    await prisma.meeting.create({
      data: {
        streamCallId: `call-${randomUUID()}`,
        appointmentOccurrenceId: occurrence.id,
      },
    });
  }
}

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
      explanation: "The recording shows no disruption.",
    },
  );
}

const blockRows = (appointmentId: string, userId: string) =>
  prisma.streamRevocationRetry.findMany({
    where: { planId: appointmentId, userId, kind: "CONDUCT_CALL_BLOCK" },
    select: { status: true, createdAt: true },
  });

const redriveBlock = (
  appointmentId: string,
  userId: string,
  deadlineMs?: number,
) =>
  redriveAccessRevocation(
    {
      kind: "CONDUCT_CALL_BLOCK",
      userId,
      planId: appointmentId,
      planType: null,
      counterpartUserId: null,
      createdAt: new Date(),
    },
    deadlineMs ? { deadlineMs } : {},
  );

async function untilOwed(appointmentId: string, userId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await blockRows(appointmentId, userId);
    if (rows.some((r) => r.status !== "SUCCEEDED")) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return blockRows(appointmentId, userId);
}

beforeEach(() => {
  stream.configured = false;
  jest.clearAllMocks();
  mockCall.kickUser.mockImplementation(async () => ({}));
  refundDoor.mockReset();
});

it("records one lapse when two deadline runs overlap", async () => {
  const { caseId } = await removed();
  const { createdAt } = await prisma.supportCase.findUniqueOrThrow({
    where: { id: caseId },
    select: { createdAt: true },
  });
  const now = new Date(createdAt.getTime() + 72 * HOUR_MS);
  const sweep = () =>
    sweepConductRemovalDeadlines({ limit: 50, now, errors: [] });

  await raceBehindLock(lockCaseRow(caseId), [sweep, sweep]);

  expect(
    await prisma.supportCaseEvent.count({
      where: { caseId, kind: "REMOVAL_REVIEW_LAPSED" },
    }),
  ).toBe(1);
});

it("blocks the attendee in every open room, past the first page", async () => {
  const webinar = await seedWebinar({ capacity: 10, price: 0 });
  const { userId } = await seat(webinar, false);
  await openRooms(webinar.appointmentId, 51);
  stream.configured = true;

  await removeAttendeeForConduct({
    appointmentId: webinar.appointmentId,
    targetUserId: userId,
    actorUserId: webinar.host.userId,
    reason: "DISRUPTIVE",
    authorizeTx: async () => true,
    note: null,
  });

  expect(
    mockCall.kickUser.mock.calls.filter(([req]) => req.user_id === userId),
  ).toHaveLength(51);
  expect(
    (await blockRows(webinar.appointmentId, userId)).map((r) => r.status),
  ).toEqual(["SUCCEEDED"]);
});

it("leaves an intent to repair a block that lands after the overturn's unblock", async () => {
  const { webinar, userId, caseId } = await removed();
  await openRooms(webinar.appointmentId, 1);
  stream.configured = true;
  let landKick: () => void = () => undefined;
  mockCall.kickUser.mockImplementationOnce(
    () => new Promise((resolve) => (landKick = () => resolve({}))),
  );

  const staleBlock = redriveBlock(webinar.appointmentId, userId);
  while (mockCall.kickUser.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await overturn(caseId);
  expect(mockCall.unblockUser).toHaveBeenCalledWith({ user_id: userId });
  landKick();
  await staleBlock;

  const rows = await untilOwed(webinar.appointmentId, userId);
  expect(rows.some((r) => r.status !== "SUCCEEDED")).toBe(true);
});

it("leaves an intent to repair a block whose call outlived its budget and landed after the unblock", async () => {
  const { webinar, userId, caseId } = await removed();
  await openRooms(webinar.appointmentId, 1);
  stream.configured = true;
  let landKick: () => void = () => undefined;
  mockCall.kickUser.mockImplementationOnce(
    () => new Promise((resolve) => (landKick = () => resolve({}))),
  );

  expect(
    await redriveBlock(webinar.appointmentId, userId, Date.now() + 200),
  ).not.toBeNull();
  await overturn(caseId);
  landKick();

  const rows = await untilOwed(webinar.appointmentId, userId);
  expect(rows.some((r) => r.status !== "SUCCEEDED")).toBe(true);
});

it("leaves an intent to repair a block that Stream applied but whose response was lost", async () => {
  const { webinar, userId, caseId } = await removed();
  await openRooms(webinar.appointmentId, 1);
  stream.configured = true;
  let loseResponse: () => void = () => undefined;
  mockCall.kickUser.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        loseResponse = () =>
          reject(new Error("Stream response lost after apply"));
      }),
  );

  const staleBlock = redriveBlock(webinar.appointmentId, userId);
  while (mockCall.kickUser.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await overturn(caseId);
  loseResponse();
  await staleBlock;

  const rows = await untilOwed(webinar.appointmentId, userId);
  expect(rows.some((r) => r.status !== "SUCCEEDED")).toBe(true);
});

it("reports failed lapse refunds through the sweep's errors, never once per case", async () => {
  const first = await removed(true);
  const second = await removed(true);
  refundDoor.mockRejectedValue(new Error("gateway unavailable"));
  const errors: string[] = [];

  await sweepConductRemovalDeadlines({
    limit: 50,
    now: new Date(Date.now() + 73 * HOUR_MS),
    errors,
  });

  expect(reportSentryError).not.toHaveBeenCalled();
  for (const { caseId } of [first, second]) {
    expect(errors.some((e) => e.includes(caseId))).toBe(true);
  }
});

it("refuses a co-host whose seat was revoked while the removal waited for its lock", async () => {
  const webinar = await seedWebinar({ capacity: 10, price: 0 });
  const { userId } = await seat(webinar, false);
  const cohost = await seedUser("CONSULTANT");
  const domain = await prisma.domain.create({
    data: { name: `db-tier-${randomUUID()}` },
  });
  const profile = await prisma.consultantProfile.create({
    data: {
      userId: cohost.userId,
      domainId: domain.id,
      scheduleType: "WEEKLY",
    },
  });
  const collaborator = await prisma.collaborator.create({
    data: {
      consultantProfileId: profile.id,
      collaboratorType: "WEBINAR",
      webinarPlanId: webinar.planId,
      role: "CO_HOST",
      tier: "PRESENTER",
      revenueShareBps: 1000,
      status: "ACCEPTED",
    },
  });
  sessionUser.current = {
    id: cohost.userId,
    role: "CONSULTANT",
    consultantProfileId: profile.id,
  };
  mockBeforeLock.run = () =>
    prisma.collaborator.update({
      where: { id: collaborator.id },
      data: { status: "REMOVED" },
    });

  const response = await handleGroupConductRemoval(
    new Request("http://test/remove", {
      method: "POST",
      body: JSON.stringify({ targetUserId: userId, reason: "DISRUPTIVE" }),
    }),
    "webinar",
    webinar.webinarId,
  );

  expect(response.status).toBe(403);
  const kept = await prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId: webinar.appointmentId, userId },
    select: { status: true },
  });
  expect(kept.status).toBe("CONFIRMED");
  expect(
    await prisma.supportCase.count({
      where: { appointmentId: webinar.appointmentId },
    }),
  ).toBe(0);
});
