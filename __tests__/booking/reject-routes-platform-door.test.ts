/**
 * @jest-environment node
 */

/**
 * The request status routes refuse an operator who is not a party with
 * PLATFORM_CANCEL_DOOR_REQUIRED, on every status, before anything is written;
 * an operator who is the expert still acts as the expert. The detail GET shows
 * a non-party STAFF user the requester in the public shape only.
 */

import { NextRequest } from "next/server";

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const user = { current: {} as Record<string, unknown> };
const mockTransaction = jest.fn(async () => {
  throw new Error("stop after the door");
});
const LEARNER_ONLY = { aboutMe: "Private", goals: "Private" };
const party = {
  consultantProfile: { id: "cp-1", user: { id: "u-expert" } },
};
const requestRow = () => ({
  id: ID,
  requestedById: "cee-1",
  requestedBy: {
    id: "cee-1",
    userId: "u-learner",
    ...LEARNER_ONLY,
    user: { id: "u-learner", name: "Priya", email: "p@x.test", image: null },
  },
  consultationPlan: party,
  subscriptionPlan: party,
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findUnique: jest.fn(async () => requestRow()),
      findUniqueOrThrow: jest.fn(async () => requestRow()),
    },
    subscription: { findUnique: jest.fn(async () => requestRow()) },
    $transaction: (...a: unknown[]) => mockTransaction(...(a as [])),
  },
}));
jest.mock("../../lib/auth-helpers", () =>
  jest
    .requireActual("../fixtures/route-auth-mock")
    .routeAuthMock(() => user.current),
);
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: {} }));
jest.mock("../../lib/stream-utils", () => ({ bookingOrgId: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import {
  GET as readConsultation,
  PATCH as patchConsultation,
} from "../../app/api/bookings/consultations/[consultationId]/route";
import { PATCH as patchConsultationList } from "../../app/api/bookings/consultations/route";
import { PATCH as patchSubscription } from "../../app/api/bookings/subscriptions/[subscriptionId]/route";
import { PATCH as patchSubscriptionList } from "../../app/api/bookings/subscriptions/route";

const patch = (url: string, body: unknown) =>
  new NextRequest(url, { method: "PATCH", body: JSON.stringify(body) });
const params = (key: string) => ({ params: Promise.resolve({ [key]: ID }) });

const routes = (status: "REJECTED" | "APPROVED") => ({
  "consultation detail": () =>
    patchConsultation(
      patch(`http://localhost/api/bookings/consultations/${ID}`, { status }),
      params("consultationId") as never,
    ),
  "subscription detail": () =>
    patchSubscription(
      patch(`http://localhost/api/bookings/subscriptions/${ID}`, { status }),
      params("subscriptionId") as never,
    ),
  ...(status === "REJECTED"
    ? {
        "consultation list": () =>
          patchConsultationList(
            patch("http://localhost/api/bookings/consultations", {
              id: ID,
              status,
            }),
          ),
        "subscription list": () =>
          patchSubscriptionList(
            patch("http://localhost/api/bookings/subscriptions", {
              id: ID,
              status,
            }),
          ),
      }
    : {}),
});

const operator = (role: string, consultantProfileId: string | null = null) => ({
  id: "u-ops",
  role,
  consultantProfileId,
  consulteeProfileId: null,
});

beforeEach(() => jest.clearAllMocks());

describe.each(["REJECTED", "APPROVED"] as const)("status %s", (status) => {
  describe.each(Object.entries(routes(status)))("on the %s", (_name, run) => {
    it.each(["ADMIN", "STAFF"])(
      "refuses %s who is not a party, before any write",
      async (role) => {
        user.current = operator(role);
        const res = await run();
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("PLATFORM_CANCEL_DOOR_REQUIRED");
        expect(mockTransaction).not.toHaveBeenCalled();
      },
    );

    it("lets staff who are the expert act as the expert", async () => {
      user.current = operator("STAFF", "cp-1");
      const res = await run();
      expect(res.status).not.toBe(403);
    });
  });
});

describe("the consultation detail read", () => {
  const requester = async () =>
    (
      await (
        await readConsultation(
          new NextRequest(`http://localhost/api/bookings/consultations/${ID}`),
          params("consultationId") as never,
        )
      ).json()
    ).data.requestedBy;

  it("shows a non-party STAFF user the public shape", async () => {
    user.current = operator("STAFF");
    expect(await requester()).toEqual({
      id: "cee-1",
      userId: "u-learner",
      user: { id: "u-learner", name: "Priya", image: null },
    });
  });

  it.each([
    ["ADMIN", operator("ADMIN")],
    ["staff who are the expert", operator("STAFF", "cp-1")],
  ])("shows %s the whole requester", async (_who, caller) => {
    user.current = caller;
    expect(await requester()).toMatchObject(LEARNER_ONLY);
  });
});
