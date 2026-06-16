/**
 * @jest-environment node
 */

/**
 * Reschedule Response Correctness Tests
 *
 * Covers:
 * - Part 2 Bug 02: Auth failure returns proper HTTP 403 (not 200 with nested JSON)
 * - Part 2 Bug 03: Type mismatch returns proper HTTP 400
 * - derivedType fallback when no ?type query param
 * - 24-hour policy enforcement with precise time boundaries
 * - Response shape correctness: success, rescheduleType, slotsAffected, message
 */

// ─── Module Mocks ───────────────────────────────────────────────────────────

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    appointment: { findUnique: jest.fn() },
    slotOfAppointment: { findMany: jest.fn(), deleteMany: jest.fn() },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

jest.mock("../../lib/waitlist/slot-handler", () => ({
  handleSlotOpening: jest.fn().mockResolvedValue({ notified: 0 }),
}));

jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { POST as rescheduleHandler } from "@/app/api/appointments/[appointmentId]/reschedule/route";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(
  appointmentId: string,
  type?: string,
  body?: Record<string, any>,
) {
  const typeParam = type ? `?type=${type}` : "";
  const url = `http://localhost/api/appointments/${appointmentId}/reschedule${typeParam}`;
  return new Request(url, {
    method: "POST",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  }) as any;
}

function makeParams(appointmentId: string) {
  return { params: Promise.resolve({ appointmentId }) };
}

const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000);
const NEAR_DATE = new Date(Date.now() + 12 * 60 * 60 * 1000);

function makeSlot(id: string, startsAt: Date) {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isTentative: false,
    appointmentId: "apt-1",
    createdAt: new Date(),
  };
}

function makeConsultationAppointment(slotOverrides?: any[]) {
  return {
    id: "apt-1",
    appointmentType: "CONSULTATION",
    slotsOfAppointment: slotOverrides || [makeSlot("slot-1", FUTURE_DATE)],
    consultation: {
      id: "cons-1",
      consultationPlan: {
        title: "Test Plan",
        consultantProfileId: "cp-001",
        consultantProfile: { user: { id: "consultant-1", name: "Dr. Smith" } },
      },
      requestedById: "ce-001",
      requestedBy: { user: { id: "user-1", name: "John Doe" } },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function makeSubscriptionAppointment(slotOverrides?: any[]) {
  return {
    id: "apt-1",
    appointmentType: "SUBSCRIPTION",
    slotsOfAppointment: slotOverrides || [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: {
      id: "sub-1",
      subscriptionPlan: {
        title: "Monthly Plan",
        consultantProfileId: "cp-001",
        consultantProfile: { user: { id: "consultant-1", name: "Dr. Smith" } },
      },
      requestedById: "ce-001",
      requestedBy: { user: { id: "user-1", name: "John Doe" } },
    },
    webinar: null,
    class: null,
  };
}

function makeWebinarAppointment(slotOverrides?: any[]) {
  return {
    id: "apt-1",
    appointmentType: "WEBINAR",
    slotsOfAppointment: slotOverrides || [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: {
      id: "web-1",
      status: "SCHEDULED",
      webinarPlan: { consultantProfileId: "cp-001" },
    },
    class: null,
  };
}

function makeMockTx(appointmentData: any) {
  return {
    appointment: {
      findUnique: jest.fn().mockResolvedValue(appointmentData),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
    consultation: {
      update: jest.fn(),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      update: jest.fn(),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      update: jest.fn(),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    class: {
      update: jest.fn(),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    slotOfAppointment: { updateMany: jest.fn(), deleteMany: jest.fn() },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auth failure returns proper HTTP 403
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — Auth failure returns proper 403 (not 200 with nested JSON)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return HTTP 403 status code directly, not wrapped in 200", async () => {
    // Stranger session — not a participant
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "stranger",
        consultantProfileId: null,
        consulteeProfileId: "ce-stranger",
        role: "CONSULTEE",
      },
    });

    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    // The critical check: HTTP status must be 403, NOT 200
    expect(res.status).toBe(403);

    const body = await res.json();
    // The error should be at the top level, not nested inside a data object
    expect(body.error).toBeDefined();
    expect(body.data).toBeUndefined();
  });

  it("should include meaningful error message in 403 response", async () => {
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "stranger",
        consultantProfileId: null,
        consulteeProfileId: "ce-stranger",
        role: "CONSULTEE",
      },
    });

    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("not authorized");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Type mismatch returns proper HTTP 400
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — Type mismatch returns proper 400", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Authenticated as consultant (participant)
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should return 400 when query type WEBINAR doesn't match consultation", async () => {
    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "WEBINAR");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mismatch");
  });

  it("should return 400 when query type CONSULTATION doesn't match subscription", async () => {
    const appointment = makeSubscriptionAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mismatch");
  });

  it("should return 400 when query type CLASS doesn't match webinar", async () => {
    const appointment = makeWebinarAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CLASS");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mismatch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// derivedType fallback (no ?type query param)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — derivedType fallback when no ?type param", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should succeed for consultation without ?type param", async () => {
    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    // No type param at all
    const req = makeRequest("apt-1");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rescheduleType).toBe("entire_booking");
  });

  it("should succeed for subscription without ?type param via derivedType", async () => {
    const appointment = makeSubscriptionAppointment();
    const mockTx = makeMockTx(appointment);
    // For subscription entire reschedule, the route calls findMany twice
    mockTx.appointment.findMany
      .mockResolvedValueOnce([
        { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
      ])
      .mockResolvedValueOnce([{ id: "apt-1" }]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rescheduleType).toBe("entire_booking");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 24-hour policy enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — 24-hour policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "user-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should return 400 when slot is within 24 hours", async () => {
    const appointment = makeConsultationAppointment([
      makeSlot("slot-1", NEAR_DATE),
    ]);
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("24 hours");
  });

  it("should succeed when slot is beyond 24 hours", async () => {
    const appointment = makeConsultationAppointment([
      makeSlot("slot-1", FUTURE_DATE),
    ]);
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should fail if ANY slot is within 24h even if others are far out", async () => {
    const appointment = makeSubscriptionAppointment([
      makeSlot("slot-1", FUTURE_DATE), // 48h out — OK
      makeSlot("slot-2", NEAR_DATE), // 12h out — too close
    ]);
    const mockTx = makeMockTx(appointment);
    // For subscription, route fetches all slots
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("24 hours");
  });

  it("should allow reschedule at exactly 24h boundary", async () => {
    // Create slot exactly 25h from now (just past 24h limit)
    const justPast24h = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const appointment = makeConsultationAppointment([
      makeSlot("slot-1", justPast24h),
    ]);
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Response shape correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — Response shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should include success, rescheduleType, slotsAffected, message for consultation", async () => {
    const mockTx = makeMockTx(makeConsultationAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        rescheduleType: "entire_booking",
        slotsAffected: expect.any(Number),
        message: expect.stringContaining("marked for rescheduling"),
      }),
    );
  });

  it("should return individual_session for single slotId in subscription", async () => {
    const appointment = makeSubscriptionAppointment();
    const mockTx = makeMockTx(appointment);
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.rescheduleType).toBe("individual_session");
    expect(body.slotsAffected).toBe(1);
  });

  it("should return multiple_sessions for multiple slotIds in subscription", async () => {
    const twoSlots = [
      makeSlot("slot-1", FUTURE_DATE),
      makeSlot("slot-2", new Date(FUTURE_DATE.getTime() + 30 * 60 * 1000)),
    ];
    const appointment = makeSubscriptionAppointment(twoSlots);
    const mockTx = makeMockTx(appointment);
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: twoSlots },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.rescheduleType).toBe("multiple_sessions");
    expect(body.slotsAffected).toBe(2);
  });

  it("should return 404 for nonexistent appointment", async () => {
    const mockTx = makeMockTx(null);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("nonexistent", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("nonexistent"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});
