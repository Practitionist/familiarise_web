/**
 * @jest-environment node
 */

/**
 * POST /api/appointments/[appointmentId]/participants/remove — who may remove
 * an attendee for conduct, and what the response carries. The removal itself is
 * covered by participant-removal.test.ts.
 */
const mockPrisma = {
  appointment: { findFirst: jest.fn() },
  membership: { findFirst: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockPrisma }));

const mockRequireApiAuth = jest.fn();
jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: () => mockRequireApiAuth(),
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (message: string) =>
    new Response(message, { status: 403 }),
}));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  participantReadLimiter: {},
}));
jest.mock("@/lib/auth/org-permissions", () => ({
  hasOrgPermission: (role: string, permission: string) =>
    role === "ORG_ADMIN" && permission === "catalog.manage",
  rolesWithOrgPermission: () => ["ORG_ADMIN"],
}));
const mockRemove = jest.fn();
jest.mock("@/lib/booking/participant-removal", () => ({
  removeParticipantForConduct: (...args: unknown[]) => mockRemove(...args),
}));
jest.mock("@/lib/booking/booking-rule-response", () => ({
  bookingRuleResponse: (error: { httpStatus: number }) =>
    new Response("rule", { status: error.httpStatus }),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
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

import { BookingRuleError } from "@/lib/booking/booking-rule-error";

const handle = async (body: unknown, appointmentId = "appt-1") => {
  const { handleGroupConductRemoval } =
    await import("@/lib/api/participants/group-participants-route");
  return handleGroupConductRemoval(
    new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    appointmentId,
  );
};

const BODY = { targetUserId: "attendee-1", reason: "DISRUPTIVE" };

function session(over: {
  id?: string;
  role?: string;
  consultantProfileId?: string | null;
}) {
  mockRequireApiAuth.mockResolvedValue({
    session: {
      user: {
        id: over.id ?? "caller-1",
        role: over.role ?? "USER",
        consultantProfileId: over.consultantProfileId ?? null,
      },
    },
  });
}

/** A webinar whose plan is owned by `owner`, with the caller's accepted presenter seats. */
function plan(over: {
  owner?: string;
  organizationId?: string | null;
  collaborators?: { id: string }[];
}) {
  mockPrisma.appointment.findFirst.mockResolvedValue({
    webinar: {
      webinarPlan: {
        consultantProfileId: over.owner ?? "profile-owner",
        organizationId: over.organizationId ?? null,
        collaborators: over.collaborators ?? [],
      },
    },
    class: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRemove.mockResolvedValue({
    removalId: "rem-1",
    caseId: "case-1",
    caseReference: "TKT-1",
    earningsHeld: true,
  });
  mockPrisma.membership.findFirst.mockResolvedValue(null);
  session({});
  plan({});
});

describe("who may remove an attendee for conduct", () => {
  it.each([
    [
      "the plan owner",
      { consultantProfileId: "profile-owner" },
      {},
      "HOST" as const,
    ],
    ["staff", { role: "STAFF" }, {}, "STAFF" as const],
    [
      "an accepted presenter-tier co-host",
      { consultantProfileId: "profile-cohost" },
      { collaborators: [{ id: "collab-1" }] },
      "CO_HOST" as const,
    ],
  ])("allows %s", async (_name, who, planOver, role) => {
    session(who);
    plan(planOver);
    const res = await handle(BODY);
    expect(res.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: "appt-1",
        targetUserId: "attendee-1",
        actor: { userId: "caller-1", role },
        reason: "DISRUPTIVE",
      }),
    );
  });

  it("allows an org operator who can manage the host org's catalog", async () => {
    plan({ organizationId: "org-1" });
    mockPrisma.membership.findFirst.mockResolvedValue({ role: "ORG_ADMIN" });
    const res = await handle(BODY);
    expect(res.status).toBe(200);
    expect(mockRemove.mock.calls[0][0].actor.role).toBe("ORG_OPERATOR");
    expect(mockPrisma.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "caller-1",
          organizationId: "org-1",
          status: "ACTIVE",
        }),
      }),
    );
  });

  it.each([
    ["an outsider", {}, {}],
    [
      "a consultant who is not on this event's plan",
      { consultantProfileId: "profile-other" },
      {},
    ],
  ])("refuses %s", async (_name, who, planOver) => {
    session(who);
    plan(planOver);
    const res = await handle(BODY);
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses an org member without the catalog or cancel permission", async () => {
    plan({ organizationId: "org-1" });
    mockPrisma.membership.findFirst.mockResolvedValue({ role: "ORG_VIEWER" });
    const res = await handle(BODY);
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("refuses an appointment that is not a webinar or class", async () => {
    mockPrisma.appointment.findFirst.mockResolvedValue({
      webinar: null,
      class: null,
    });
    const res = await handle(BODY);
    expect(res.status).toBe(403);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  it("rejects a missing reason and an 'Other' with no note", async () => {
    expect((await handle({ targetUserId: "attendee-1" })).status).toBe(400);
    expect(
      (await handle({ targetUserId: "attendee-1", reason: "OTHER" })).status,
    ).toBe(400);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("accepts 'Other' with a note", async () => {
    session({ consultantProfileId: "profile-owner" });
    const res = await handle({
      targetUserId: "attendee-1",
      reason: "OTHER",
      note: "Kept sharing a private link",
    });
    expect(res.status).toBe(200);
  });

  it("will not let the caller remove themselves", async () => {
    session({ id: "attendee-1", consultantProfileId: "profile-owner" });
    const res = await handle(BODY);
    expect(res.status).toBe(400);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("answers with the case reference and whether earnings are held", async () => {
    session({ consultantProfileId: "profile-owner" });
    const res = await handle(BODY);
    await expect(res.json()).resolves.toEqual({
      removed: true,
      caseReference: "TKT-1",
      earningsHeld: true,
    });
  });

  it("answers removed:false for a repeat request", async () => {
    session({ consultantProfileId: "profile-owner" });
    mockRemove.mockResolvedValue(null);
    const res = await handle(BODY);
    await expect(res.json()).resolves.toEqual({ removed: false });
  });

  it("turns a booking rule refusal into its status", async () => {
    session({ consultantProfileId: "profile-owner" });
    mockRemove.mockRejectedValue(
      new BookingRuleError("EVENT_NOT_FOUND", "nope", 404),
    );
    expect((await handle(BODY)).status).toBe(404);
  });
});
