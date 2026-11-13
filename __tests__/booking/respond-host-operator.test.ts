/**
 * @jest-environment node
 */
import "../booking-algorithm/setup";

const mockFindFirst = jest.fn();
const mockHostActor = jest.fn();
const mockOrgAdmin = jest.fn();
const mockDecline = jest.fn();
const session = {
  current: { id: "u", role: "CONSULTANT" } as Record<string, unknown>,
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    rescheduleRequest: { findFirst: (...a: unknown[]) => mockFindFirst(...a) },
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: session.current } }),
  resolveEventHostActor: (...a: unknown[]) => mockHostActor(...a),
}));
jest.mock("@/lib/booking/org-actor", () => ({
  isOrgAdminOfAppointment: (...a: unknown[]) => mockOrgAdmin(...a),
}));
jest.mock("@/lib/booking/reschedule-respond", () => ({
  declineProposal: (...a: unknown[]) => mockDecline(...a),
  acceptProposal: jest.fn(),
}));
jest.mock("@/lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  rescheduleAppointmentLimiter: {},
}));
jest.mock("@/lib/enterprise/suspended-member-sessions", () => ({
  isSuspendedInFundingOrg: jest.fn(async () => false),
  membershipSuspendedResponse: jest.fn(),
}));
jest.mock("@/lib/payments/dispute-guard", () => ({
  hasActiveDisputeForAppointment: jest.fn(async () => false),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/appointments/[appointmentId]/reschedule/respond/route";

const open = (
  initiatorRole: "CONSULTEE" | "CONSULTANT",
  initiatedById: string,
) => ({
  id: "req-1",
  initiatedById,
  initiatorRole,
  appointment: {
    consultationId: "cons-1",
    subscriptionId: null,
    organizationId: null,
    consultation: { requestedBy: { userId: "consultee-user" } },
    subscription: null,
  },
});

const decline = () =>
  POST(
    new NextRequest(
      "http://localhost/api/appointments/appt-1/reschedule/respond",
      {
        method: "POST",
        body: JSON.stringify({ action: "decline" }),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId: "appt-1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockDecline.mockResolvedValue({ done: true, restoredFully: true });
  mockOrgAdmin.mockResolvedValue(false);
  mockHostActor.mockResolvedValue(null);
});

describe("reschedule answers on org-hosted plans", () => {
  it("a host-org operator answers a consultee's proposal", async () => {
    mockFindFirst.mockResolvedValue(open("CONSULTEE", "consultee-user"));
    mockHostActor.mockResolvedValue("host-org");
    session.current = { id: "operator-user", role: "CONSULTEE" };
    const res = await decline();
    expect(res.status).toBe(200);
    expect(mockHostActor).toHaveBeenCalledWith(
      // Judged as a party: the side check passes the caller without the role.
      { user: { ...session.current, role: null } },
      "consultation",
      "cons-1",
    );
    expect(mockDecline).toHaveBeenCalledWith({
      rescheduleRequestId: "req-1",
      resolvedById: "operator-user",
    });
  });

  it("the consultee answers a proposal a host-org operator made", async () => {
    mockFindFirst.mockResolvedValue(open("CONSULTANT", "operator-user"));
    session.current = { id: "consultee-user", role: "CONSULTEE" };
    expect((await decline()).status).toBe(200);
  });

  it("the paying org's admin answers a consultant-side proposal", async () => {
    mockFindFirst.mockResolvedValue(open("CONSULTANT", "expert-user"));
    mockOrgAdmin.mockResolvedValue(true);
    session.current = { id: "payer-admin", role: "CONSULTEE" };
    expect((await decline()).status).toBe(200);
  });

  it("nobody answers their own proposal, and staff never answer here", async () => {
    mockFindFirst.mockResolvedValue(open("CONSULTEE", "consultee-user"));
    session.current = { id: "consultee-user", role: "CONSULTEE" };
    expect((await decline()).status).toBe(404);

    mockHostActor.mockResolvedValue("staff");
    session.current = { id: "staff-user", role: "STAFF" };
    expect((await decline()).status).toBe(404);
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it("a consultee cannot answer a consultee-side proposal on someone's behalf", async () => {
    mockFindFirst.mockResolvedValue(open("CONSULTEE", "payer-admin"));
    session.current = { id: "consultee-user", role: "CONSULTEE" };
    expect((await decline()).status).toBe(404);
  });
});
