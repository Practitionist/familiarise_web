/**
 * @jest-environment node
 */

/**
 * The in-room removal route and the two "report a concern" link routes: who may
 * remove an attendee from a live room, and that the support link only answers
 * to a party of the booking.
 */
const mockGuard = jest.fn();
jest.mock("@/lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...args: unknown[]) => mockGuard(...args),
}));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  meetingStageLimiter: {},
  eventMutationLimiter: {},
  participantReadLimiter: {},
}));
jest.mock("@/lib/stream-logger", () => ({
  streamLogger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const mockRemove = jest.fn();
jest.mock("@/lib/booking/participant-removal", () => ({
  removeParticipantForConduct: (...args: unknown[]) => mockRemove(...args),
}));
jest.mock("@/lib/booking/booking-rule-response", () => ({
  bookingRuleResponse: (error: { httpStatus: number }) =>
    new Response("rule", { status: error.httpStatus }),
}));

const mockPrisma = {
  webinar: { findUnique: jest.fn() },
  class: { findUnique: jest.fn() },
  appointment: { count: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockPrisma }));
const mockRequireApiAuth = jest.fn();
jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: () => mockRequireApiAuth(),
  isPrivileged: () => false,
  forbiddenResponse: (message: string) =>
    new Response(message, { status: 403 }),
}));
jest.mock("@/lib/moderation/report-case", () => ({
  bookingPartyWhere: (userId: string) => ({ party: userId }),
}));
jest.mock("@/lib/booking/seat-leave", () => ({ leaveEventSeat: jest.fn() }));
jest.mock("@/lib/data/seat-payments", () => ({ readSeatPayments: jest.fn() }));
jest.mock("@/lib/appointments/live-event-slot", () => ({
  findLiveEventSlot: jest.fn(),
}));
jest.mock("@/lib/payments/operations/refund-owed", () => ({
  recordRefundNeedsSupport: jest.fn(),
}));
jest.mock("@/actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(),
}));
jest.mock("@/lib/auth/org-permissions", () => ({
  hasOrgPermission: jest.fn(),
  rolesWithOrgPermission: () => [],
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";

const BODY = { targetUserId: "attendee-1", reason: "HARASSMENT" };

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/meetings/[meetingId]/remove/route");
  return POST(
    new NextRequest("http://localhost/api/meetings/m1/remove", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ meetingId: "m1" }) },
  );
};

function room(over: {
  role?: "host" | "participant";
  coPresenter?: boolean;
  appointment?: Record<string, unknown> | null;
  userId?: string;
}) {
  mockGuard.mockResolvedValue({
    ok: true,
    userId: over.userId ?? "host-1",
    meetingId: "m1",
    access: {
      role: over.role ?? "host",
      ...(over.coPresenter ? { coPresenter: true } : {}),
      appointment:
        over.appointment === undefined
          ? { id: "appt-1", appointmentType: "WEBINAR", webinar: { id: "w" } }
          : over.appointment,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRemove.mockResolvedValue({
    removalId: "rem-1",
    caseId: "case-1",
    caseReference: "TKT-9",
    earningsHeld: false,
  });
  room({});
});

describe("POST /api/meetings/[meetingId]/remove", () => {
  it("lets the host remove an attendee, keyed by the room's appointment", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith({
      appointmentId: "appt-1",
      targetUserId: "attendee-1",
      actor: { userId: "host-1", role: "HOST" },
      reason: "HARASSMENT",
      note: undefined,
    });
    await expect(res.json()).resolves.toEqual({
      removed: true,
      caseReference: "TKT-9",
      earningsHeld: false,
    });
  });

  it("records an accepted co-presenter as a co-host", async () => {
    room({ coPresenter: true });
    await post(BODY);
    expect(mockRemove.mock.calls[0][0].actor.role).toBe("CO_HOST");
  });

  it("refuses an attendee", async () => {
    room({ role: "participant" });
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses a 1:1 session room", async () => {
    room({ appointment: { id: "appt-1", appointmentType: "CONSULTATION" } });
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("passes the guard's refusal through untouched", async () => {
    mockGuard.mockResolvedValue({
      ok: false,
      response: new Response("nope", { status: 401 }),
    });
    expect((await post(BODY)).status).toBe(401);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("rejects a bad body and a self-removal", async () => {
    expect((await post({ targetUserId: "attendee-1" })).status).toBe(400);
    expect(
      (await post({ targetUserId: "host-1", reason: "DISRUPTIVE" })).status,
    ).toBe(400);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe("GET /api/meetings/[meetingId]/support", () => {
  const get = async () => {
    const { GET } =
      await import("@/app/api/meetings/[meetingId]/support/route");
    return GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ meetingId: "m1" }),
    });
  };

  it("points anyone in the room at the booking's support page", async () => {
    room({ role: "participant" });
    const res = await get();
    await expect(res.json()).resolves.toEqual({
      href: "/dashboard/support/b_appt-1",
    });
  });

  it("answers 404 when the room has no booking", async () => {
    room({ appointment: null });
    expect((await get()).status).toBe(404);
  });
});

describe("the event support link", () => {
  const link = async () => {
    const { handleGroupSupportLink } =
      await import("@/lib/api/participants/group-participants-route");
    return handleGroupSupportLink("webinar", "web-1");
  };

  beforeEach(() => {
    mockRequireApiAuth.mockResolvedValue({ session: { user: { id: "u1" } } });
    mockPrisma.webinar.findUnique.mockResolvedValue({
      appointment: { id: "appt-1" },
    });
    mockPrisma.appointment.count.mockResolvedValue(1);
  });

  it("answers a party of the booking with its support page", async () => {
    const res = await link();
    await expect(res.json()).resolves.toEqual({
      href: "/dashboard/support/b_appt-1",
    });
    expect(mockPrisma.appointment.count).toHaveBeenCalledWith({
      where: { id: "appt-1", party: "u1" },
    });
  });

  it("answers a stranger exactly like a missing event", async () => {
    mockPrisma.appointment.count.mockResolvedValue(0);
    const res = await link();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Webinar not found");
  });

  it("answers 404 for an event with no booking", async () => {
    mockPrisma.webinar.findUnique.mockResolvedValue(null);
    expect((await link()).status).toBe(404);
    expect(mockPrisma.appointment.count).not.toHaveBeenCalled();
  });
});
