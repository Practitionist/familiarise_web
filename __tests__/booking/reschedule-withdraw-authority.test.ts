/**
 * @jest-environment node
 */

/**
 * Only the initiator withdraws an open reschedule, and only while they still
 * act for the side they opened it from: an expert whose account is STAFF is
 * still the expert, and a learner suspended in the funding org moves nothing.
 */

const caller = {
  current: { id: "u-ops", role: "CONSULTANT", consultantProfileId: null } as {
    id: string;
    role: string;
    consultantProfileId: string | null;
  },
};
const open = {
  current: {
    id: "rr-1",
    initiatedById: "u-ops",
    initiatorRole: "CONSULTANT",
    appointment: {
      consultationId: "con-1",
      subscriptionId: null,
      organizationId: "org-1",
      consultation: { requestedBy: { userId: "u-buyer" } },
      subscription: null,
      trial: null,
    },
  },
};
const hostOrgOperators = new Set<string>();
const mockSuspended = jest.fn(async () => false);
// The real helper answers "staff" for a privileged role unless asked as a party.
const mockHostActor = jest.fn(
  async (
    session: {
      user: { id: string; role: string; consultantProfileId: string | null };
    },
    _eventType: string,
    _eventId: string,
    options: { asParty?: boolean } = {},
  ) => {
    const privileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (privileged && !options.asParty) return "staff";
    if (session.user.consultantProfileId === "cp-1") return "consultant";
    return hostOrgOperators.has(session.user.id) ? "host-org" : null;
  },
);
const mockWithdraw = jest.fn(async () => ({ withdrawn: true }));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    rescheduleRequest: { findFirst: jest.fn(async () => open.current) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({ session: { user: caller.current } })),
  resolveEventHostActor: (...a: Parameters<typeof mockHostActor>) =>
    mockHostActor(...a),
}));
jest.mock("../../lib/enterprise/suspended-member-sessions", () => ({
  isSuspendedInFundingOrg: (...a: unknown[]) => mockSuspended(...(a as [])),
  membershipSuspendedResponse: () =>
    Response.json({ code: "MEMBERSHIP_SUSPENDED" }, { status: 403 }),
}));
jest.mock("../../lib/booking/org-actor", () => ({
  isOrgAdminOfAppointment: jest.fn(async () => false),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  rescheduleAppointmentLimiter: {},
}));
jest.mock("../../lib/booking/reschedule-withdraw", () => ({
  withdrawRescheduleRequest: (...a: unknown[]) => mockWithdraw(...(a as [])),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/appointments/[appointmentId]/reschedule/withdraw/route";

const withdraw = () =>
  POST(
    new NextRequest(
      "http://localhost/api/appointments/apt-1/reschedule/withdraw",
      {
        method: "POST",
      },
    ),
    { params: Promise.resolve({ appointmentId: "apt-1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  caller.current = {
    id: "u-ops",
    role: "CONSULTANT",
    consultantProfileId: null,
  };
  open.current = {
    ...open.current,
    initiatedById: "u-ops",
    initiatorRole: "CONSULTANT",
  };
  hostOrgOperators.clear();
  mockSuspended.mockResolvedValue(false);
});

it("lets a host-org operator who still holds the role withdraw", async () => {
  hostOrgOperators.add("u-ops");
  expect((await withdraw()).status).toBe(200);
  expect(mockWithdraw).toHaveBeenCalled();
});

it("refuses an initiator who has since left the host org", async () => {
  const res = await withdraw();
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("NO_LONGER_A_PARTY");
  expect(mockWithdraw).not.toHaveBeenCalled();
});

it("lets the buyer who opened it withdraw", async () => {
  caller.current = {
    id: "u-buyer",
    role: "CONSULTEE",
    consultantProfileId: null,
  };
  open.current = {
    ...open.current,
    initiatedById: "u-buyer",
    initiatorRole: "CONSULTEE",
  };
  expect((await withdraw()).status).toBe(200);
});

it("answers 404 to anyone but the initiator", async () => {
  caller.current = {
    id: "u-other",
    role: "CONSULTEE",
    consultantProfileId: null,
  };
  expect((await withdraw()).status).toBe(404);
  expect(mockWithdraw).not.toHaveBeenCalled();
});

it.each(["STAFF", "ADMIN"])(
  "lets the expert whose account is %s withdraw their own proposal",
  async (role) => {
    caller.current = { id: "u-ops", role, consultantProfileId: "cp-1" };
    expect((await withdraw()).status).toBe(200);
    expect(mockWithdraw).toHaveBeenCalled();
  },
);

it("refuses a non-party STAFF initiator", async () => {
  caller.current = { id: "u-ops", role: "STAFF", consultantProfileId: null };
  expect((await withdraw()).status).toBe(403);
  expect(mockWithdraw).not.toHaveBeenCalled();
});

it("refuses a buyer suspended in the organisation funding the booking", async () => {
  caller.current = {
    id: "u-buyer",
    role: "CONSULTEE",
    consultantProfileId: null,
  };
  open.current = {
    ...open.current,
    initiatedById: "u-buyer",
    initiatorRole: "CONSULTEE",
  };
  mockSuspended.mockResolvedValue(true);
  const res = await withdraw();
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("MEMBERSHIP_SUSPENDED");
  expect(mockWithdraw).not.toHaveBeenCalled();
});
