/**
 * @jest-environment node
 */

/**
 * PUT /api/user/[id] applies the 18+ rule to every date-of-birth write: an
 * under-18 date is a typed 400 VALIDATION on `dateOfBirth` and writes nothing.
 */

const mockUserUpdate = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { update: (...a: unknown[]) => mockUserUpdate(...a) },
    consultantProfile: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "user_1", role: "CONSULTEE" } },
  })),
}));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/data/user-details", () => ({ getUserDetails: jest.fn() }));
jest.mock("../../utils/onboarding-server", () => ({}));
jest.mock("../../lib/compliance/erasure/scrub-user", () => ({}));
jest.mock("../../lib/novu/subscriber", () => ({}));
jest.mock("../../lib/data/public-cache", () => ({
  purgeExpertSurfaces: jest.fn(),
}));

import { NextRequest } from "next/server";
import { PUT } from "@/app/api/user/[id]/route";
import { UNDER_AGE_MESSAGE } from "@/lib/compliance/age";

const NOW = new Date("2031-03-15T12:00:00Z");

const put = (body: Record<string, unknown>) =>
  PUT(
    new NextRequest("https://x.test/api/user/user_1", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "user_1" }) },
  );

beforeAll(() => {
  // Only Date is faked, years ahead of the real clock; the body stream needs real timers.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "queueMicrotask",
    ],
  });
});
afterAll(() => jest.useRealTimers());
beforeEach(() => {
  mockUserUpdate.mockReset().mockResolvedValue({ id: "user_1" });
});

it("refuses a date of birth one day short of 18 and writes nothing", async () => {
  const res = await put({ name: "Asha", dateOfBirth: "2013-03-16" });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: UNDER_AGE_MESSAGE,
    code: "VALIDATION",
    field: "dateOfBirth",
  });
  expect(mockUserUpdate).not.toHaveBeenCalled();
});

it("accepts an 18th birthday today and writes the parsed date", async () => {
  const res = await put({ dateOfBirth: "2013-03-15" });

  expect(res.status).toBe(200);
  expect(mockUserUpdate).toHaveBeenCalledTimes(1);
  expect(mockUserUpdate.mock.calls[0][0].data.dateOfBirth).toEqual(
    new Date("2013-03-15"),
  );
});
