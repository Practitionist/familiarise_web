/**
 * @jest-environment node
 */

/**
 * Trial create decides the buyer by the learner profile, never the global
 * role; nobody trials their own plan; only LEARNER memberships tag an org;
 * and the expert's open-request cap is counted and written under its lock.
 */

const session = {
  user: {
    id: "u-dual",
    role: "CONSULTANT",
    consulteeProfileId: "cee-dual",
    consultantProfileId: "cp-dual",
  },
};
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session }),
}));
jest.mock("../../lib/rate-limit", () => ({
  trialRequestRefusal: async () => null,
  spendTrialRequest: async () => undefined,
}));
jest.mock("../../lib/booking/participants", () => ({
  recordParticipants: jest.fn(),
}));
jest.mock("../../lib/trials/book-trial", () =>
  jest.requireActual("../fixtures/trial-request-mocks").bookTrialModule(),
);
jest.mock("../../lib/trials/schedule-notices", () =>
  jest.requireActual("../fixtures/trial-request-mocks").scheduleNoticesModule(),
);
jest.mock("../../lib/email/senders/booking", () =>
  jest.requireActual("../fixtures/trial-request-mocks").bookingEmailModule(),
);
jest.mock("../../lib/novu/stage-then-attempt", () =>
  jest
    .requireActual("../fixtures/trial-request-mocks")
    .flushNotificationsModule(),
);
jest.mock("../../lib/payments/operations/approval-payment", () => ({
  createApprovalPaymentIntent: jest.fn(),
}));
jest.mock("../../lib/trials/pay-link", () => ({
  persistTrialPayLink: jest.fn(),
}));

const lock = {
  busy: false,
  events: [] as string[],
};
jest.mock("../../utils/appointmentlock", () => {
  class RequestCapBusyError extends Error {
    readonly httpStatus = 409 as const;
    readonly retryAfterSeconds = 5;
    readonly code = "REQUEST_CAP_BUSY" as const;
  }
  class BookingLockUnavailableError extends Error {
    readonly httpStatus = 503;
  }
  return {
    RequestCapBusyError,
    BookingLockUnavailableError,
    lockRequestCap: jest.fn(async (cp: string) => {
      if (lock.busy) throw new RequestCapBusyError("busy");
      lock.events.push(`lock:${cp}`);
      return { key: `request-cap:${cp}` };
    }),
    unlockRequestCap: jest.fn(async () => {
      lock.events.push("unlock");
    }),
  };
});

const state = {
  planOwner: "cp-other",
  maxOpenRequests: null as number | null,
  openRequests: 0,
  learnerMembership: true as boolean,
};
const trialCreate = jest.fn(async () => {
  lock.events.push("create");
  return {
    id: "trial-1",
    status: "PENDING",
    appointmentId: null,
    consulteeProfile: { user: { name: "Dual" } },
    consultantProfile: { user: { id: "u-other", name: "Other" } },
  };
});
const membershipFindFirst = jest.fn(
  async ({ where }: { where: { role?: string } }) =>
    where.role === "LEARNER" && state.learnerMembership ? { id: "m-1" } : null,
);
jest.mock("../../lib/prisma", () => {
  const count = jest.fn(async () => state.openRequests);
  const tx = {
    appointment: { create: jest.fn() },
    trial: {
      create: (...a: unknown[]) => trialCreate(...(a as [])),
      count: jest.fn(async () => 0),
    },
    consultation: { count },
    subscription: { count: jest.fn(async () => 0) },
  };
  return {
    __esModule: true,
    default: {
      trial: { findFirst: jest.fn(async () => null) },
      consultantProfile: { findUnique: jest.fn(async () => null) },
      membership: {
        findFirst: (...a: unknown[]) =>
          membershipFindFirst(...(a as [{ where: { role?: string } }])),
      },
      subscriptionPlan: {
        findUnique: jest.fn(async () => ({
          id: "plan-1",
          title: "Mentorship",
          consultantProfileId: state.planOwner,
          trialEnabled: true,
          trialDurationMinutes: 30,
          trialPriceInPaise: 0,
          status: "PUBLISHED",
          consultantProfile: {
            id: state.planOwner,
            acceptingRequests: true,
            maxOpenRequests: state.maxOpenRequests,
            user: { id: "u-other", name: "Other" },
          },
        })),
      },
      consulteeProfile: {
        findUnique: jest.fn(async () => ({
          user: { id: "u-dual", name: "Dual", image: null },
        })),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/trials/route";

const pickStart = new Date(
  Math.ceil((Date.now() + 3 * 86_400_000) / 3_600_000) * 3_600_000,
);
const pickedSlot = {
  startsAt: pickStart.toISOString(),
  endsAt: new Date(pickStart.getTime() + 30 * 60_000).toISOString(),
};

const post = (body: Record<string, unknown> = {}) =>
  POST(
    new NextRequest("http://localhost/api/trials", {
      method: "POST",
      body: JSON.stringify({
        consulteeProfileId: "cee-dual",
        consultantProfileId: state.planOwner,
        subscriptionPlanId: "plan-1",
        slot: pickedSlot,
        ...body,
      }),
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  session.user.role = "CONSULTANT";
  session.user.consultantProfileId = "cp-dual";
  state.planOwner = "cp-other";
  state.maxOpenRequests = null;
  state.openRequests = 0;
  state.learnerMembership = true;
  lock.busy = false;
  lock.events = [];
});

it("a CONSULTANT-role user with a learner profile can request a trial from another expert", async () => {
  const res = await post();
  expect(res.status).toBe(201);
  expect(trialCreate).toHaveBeenCalled();
});

it("an ORG_WORKSPACE-role user is gated on the learner profile too", async () => {
  session.user.role = "ORG_WORKSPACE";
  expect((await post()).status).toBe(201);
});

it("naming someone else's learner profile is still forbidden", async () => {
  const res = await post({ consulteeProfileId: "cee-someone-else" });
  expect(res.status).toBe(403);
  expect(trialCreate).not.toHaveBeenCalled();
});

it("a user cannot trial their own plan: 409 SELF_BOOKING, nothing written", async () => {
  state.planOwner = "cp-dual";
  const res = await post();
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("SELF_BOOKING");
  expect(trialCreate).not.toHaveBeenCalled();
  expect(lock.events).toEqual([]);
});

it("tags an org only through a LEARNER membership", async () => {
  state.learnerMembership = false;
  const res = await post({ organizationId: "org-b" });
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("ORG_LEARNER_REQUIRED");
  expect(membershipFindFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ role: "LEARNER", status: "ACTIVE" }),
    }),
  );
  expect(trialCreate).not.toHaveBeenCalled();
});

it("counts and creates under the expert's request-cap lock, then releases it", async () => {
  state.maxOpenRequests = 5;
  state.openRequests = 1;
  expect((await post()).status).toBe(201);
  expect(lock.events).toEqual(["lock:cp-other", "create", "unlock"]);
});

it("refuses at the cap with 409 CONSULTANT_AT_CAPACITY and still releases the lock", async () => {
  state.maxOpenRequests = 1;
  state.openRequests = 1;
  const res = await post();
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("CONSULTANT_AT_CAPACITY");
  expect(trialCreate).not.toHaveBeenCalled();
  expect(lock.events).toEqual(["lock:cp-other", "unlock"]);
});

it("a busy cap lock answers 409 REQUEST_CAP_BUSY with a retry hint", async () => {
  lock.busy = true;
  const res = await post();
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("REQUEST_CAP_BUSY");
  expect(body.retryAfter).toBe(5);
  expect(trialCreate).not.toHaveBeenCalled();
});
