/**
 * @jest-environment node
 */

/** A typed refusal inside the approval transaction answers 409 without a Sentry capture; a fault still captures. */

import { NextRequest } from "next/server";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";
import { BookingRuleError } from "../../lib/booking/booking-rule-error";

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const thrown = { current: new Error("unset") as Error };
const party = { consultantProfile: { id: "cp-1", user: { id: "u-expert" } } };
const requestRow = () => ({
  id: ID,
  requestedById: "cee-1",
  requestedBy: { id: "cee-1", userId: "u-learner", user: { id: "u-learner" } },
  consultationPlan: party,
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findUnique: jest.fn(async () => requestRow()),
      findUniqueOrThrow: jest.fn(async () => requestRow()),
    },
    $transaction: jest.fn(async () => {
      throw thrown.current;
    }),
  },
}));
jest.mock("../../lib/auth-helpers", () =>
  jest.requireActual("../fixtures/route-auth-mock").routeAuthMock(() => ({
    id: "u-expert",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: null,
  })),
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
const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
}));

import { PATCH } from "../../app/api/bookings/consultations/[consultationId]/route";

const reject = () =>
  PATCH(
    new NextRequest(`http://localhost/api/bookings/consultations/${ID}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "REJECTED" }),
    }),
    { params: Promise.resolve({ consultationId: ID }) } as never,
  );

beforeEach(() => captureException.mockClear());

it.each([
  [
    "an illegal transition",
    new IllegalTransitionError("Consultation", "REJECTED"),
  ],
  ["a booking rule", new BookingRuleError("ALREADY_REGISTERED", "Taken")],
])("answers %s with 409 and no capture", async (_n, error) => {
  thrown.current = error;
  const res = await reject();
  expect(res.status).toBe(409);
  expect(captureException).not.toHaveBeenCalled();
});

it("still captures a fault", async () => {
  thrown.current = new Error("db down");
  const res = await reject();
  expect(res.status).toBe(500);
  expect(captureException).toHaveBeenCalled();
});
