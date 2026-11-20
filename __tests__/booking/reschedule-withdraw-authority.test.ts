/**
 * @jest-environment node
 */

/**
 * The initiator withdraws an open reschedule, and only while they still act
 * for the side they opened it from: an expert whose account is STAFF is still
 * the expert, and a learner suspended in the funding org moves nothing. A move
 * an organisation actor opened may also be withdrawn by anyone acting for that
 * same side; a party's own move, and the other side's, stay out of reach.
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
      consultation: {
        requestedBy: { userId: "u-buyer" },
        consultationPlan: { consultantProfile: { userId: "u-expert" } },
      },
      subscription: null,
      trial: null,
    },
  },
};
const hostOrgOperators = new Set<string>();
const mockSponsorAdmins = new Set<string>();
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
  isOrgAdminOfAppointment: jest.fn(async (userId: string) =>
    mockSponsorAdmins.has(userId),
  ),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  rescheduleAppointmentLimiter: {},
}));
// The authority the route asks is the real one; only the withdrawal is stubbed.
jest.mock("../../lib/booking/reschedule-withdraw", () => ({
  ...jest.requireActual("../../lib/booking/reschedule-withdraw"),
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
  mockSponsorAdmins.clear();
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

describe("a move an organisation actor opened", () => {
  const BUYER = { id: "u-buyer", role: "CONSULTEE", consultantProfileId: null };
  const EXPERT = {
    id: "u-expert",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
  };
  const sponsorMove = () => {
    mockSponsorAdmins.add("u-sponsor");
    open.current = {
      ...open.current,
      initiatedById: "u-sponsor",
      initiatorRole: "CONSULTEE",
    };
  };

  it("lets the learner withdraw the sponsor admin's move", async () => {
    sponsorMove();
    caller.current = BUYER;
    const res = await withdraw();
    expect(res.status).toBe(200);
    // Not "your request": the learner did not open it.
    expect((await res.json()).message).toBe(
      "The request to move this booking has been withdrawn, so it keeps its original time.",
    );
    expect(mockWithdraw).toHaveBeenCalledWith({
      rescheduleRequestId: "rr-1",
      withdrawnById: "u-buyer",
      sameSideActor: true,
    });
  });

  it("lets another admin of the sponsor withdraw it", async () => {
    sponsorMove();
    mockSponsorAdmins.add("u-sponsor-2");
    caller.current = { ...BUYER, id: "u-sponsor-2" };
    expect((await withdraw()).status).toBe(200);
  });

  it("lets the plan's expert withdraw a host-org operator's move", async () => {
    hostOrgOperators.add("u-ops");
    caller.current = EXPERT;
    expect((await withdraw()).status).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledWith({
      rescheduleRequestId: "rr-1",
      withdrawnById: "u-expert",
      sameSideActor: true,
    });
  });

  it("answers 404 to the other side", async () => {
    sponsorMove();
    caller.current = EXPERT;
    expect((await withdraw()).status).toBe(404);

    open.current = {
      ...open.current,
      initiatedById: "u-ops",
      initiatorRole: "CONSULTANT",
    };
    caller.current = BUYER;
    expect((await withdraw()).status).toBe(404);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it("refuses a learner suspended in the organisation funding the booking", async () => {
    sponsorMove();
    caller.current = BUYER;
    mockSuspended.mockResolvedValue(true);
    const res = await withdraw();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("MEMBERSHIP_SUSPENDED");
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

describe("a party's own move", () => {
  it("is not the sponsor admin's to withdraw", async () => {
    mockSponsorAdmins.add("u-sponsor");
    open.current = {
      ...open.current,
      initiatedById: "u-buyer",
      initiatorRole: "CONSULTEE",
    };
    caller.current = {
      id: "u-sponsor",
      role: "CONSULTEE",
      consultantProfileId: null,
    };
    expect((await withdraw()).status).toBe(404);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it("is not a host-org operator's to withdraw", async () => {
    hostOrgOperators.add("u-ops");
    open.current = {
      ...open.current,
      initiatedById: "u-expert",
      initiatorRole: "CONSULTANT",
    };
    expect((await withdraw()).status).toBe(404);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});
