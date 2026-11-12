/**
 * @jest-environment node
 */

/**
 * The four request decline routes refuse an operator who is not a party with
 * PLATFORM_CANCEL_DOOR_REQUIRED before anything is written; an operator who is
 * the expert on the booking still declines as the expert.
 */

import { NextRequest, NextResponse } from "next/server";

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const user = { current: {} as Record<string, unknown> };
const mockTransaction = jest.fn(async () => {
  throw new Error("stop after the door");
});
const party = {
  consultantProfile: { id: "cp-1", user: { id: "u-expert" } },
};
const requestRow = {
  id: ID,
  requestedById: "cee-1",
  requestedBy: { user: { id: "u-learner" } },
  consultationPlan: party,
  subscriptionPlan: party,
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findUnique: jest.fn(async () => requestRow) },
    subscription: { findUnique: jest.fn(async () => requestRow) },
    $transaction: (...a: unknown[]) => mockTransaction(...(a as [])),
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(async () => ({ session: { user: user.current } })),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (error: string) =>
    NextResponse.json({ error }, { status: 403 }),
}));
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

import { PATCH as patchConsultation } from "../../app/api/bookings/consultations/[consultationId]/route";
import { PATCH as patchConsultationList } from "../../app/api/bookings/consultations/route";
import { PATCH as patchSubscription } from "../../app/api/bookings/subscriptions/[subscriptionId]/route";
import { PATCH as patchSubscriptionList } from "../../app/api/bookings/subscriptions/route";

const decline = (url: string, body: unknown) =>
  new NextRequest(url, { method: "PATCH", body: JSON.stringify(body) });
const params = (key: string) => ({ params: Promise.resolve({ [key]: ID }) });

const routes = {
  "consultation detail": () =>
    patchConsultation(
      decline(`http://localhost/api/bookings/consultations/${ID}`, {
        status: "REJECTED",
      }),
      params("consultationId") as never,
    ),
  "consultation list": () =>
    patchConsultationList(
      decline("http://localhost/api/bookings/consultations", {
        id: ID,
        status: "REJECTED",
      }),
    ),
  "subscription detail": () =>
    patchSubscription(
      decline(`http://localhost/api/bookings/subscriptions/${ID}`, {
        status: "REJECTED",
      }),
      params("subscriptionId") as never,
    ),
  "subscription list": () =>
    patchSubscriptionList(
      decline("http://localhost/api/bookings/subscriptions", {
        id: ID,
        status: "REJECTED",
      }),
    ),
};

const operator = (role: string, consultantProfileId: string | null = null) => ({
  id: "u-ops",
  role,
  consultantProfileId,
  consulteeProfileId: null,
});

beforeEach(() => jest.clearAllMocks());

describe.each(Object.entries(routes))("%s decline", (_name, run) => {
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

  it("lets staff who are the expert decline as the expert", async () => {
    user.current = operator("STAFF", "cp-1");
    await run();
    expect(mockTransaction).toHaveBeenCalled();
  });
});
