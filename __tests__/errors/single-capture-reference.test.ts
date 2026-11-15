/**
 * @jest-environment node
 */

/**
 * A route that fails in a way nobody recognised reports the fault to Sentry
 * once, and the reference it shows the user is that event's id, so an
 * operator can find it.
 */

let nextEventId = 0;
const captureException = jest.fn(() => {
  nextEventId += 1;
  return `${String(nextEventId).padStart(8, "0")}${"f".repeat(24)}`;
});
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...(args as [])),
  captureMessage: jest.fn(),
  getCurrentScope: () => ({ setTag: jest.fn(), setUser: jest.fn() }),
  setUser: jest.fn(),
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

const failingRead = jest.fn(async () => {
  throw new Error(
    "Invalid `prisma.consultantProfile.findMany()` invocation: boom",
  );
});
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get: () => new Proxy({}, { get: () => failingRead }),
    },
  ),
}));

// The default page read is cached; pass through so the request reaches Prisma.
jest.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/consultants/route";

beforeEach(() => {
  captureException.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

it("captures an unrecognised failure once and shows that event's id as the reference", async () => {
  const res = await GET(
    new NextRequest("http://localhost/api/user/consultants?page=1&limit=12"),
  );
  const body = await res.json();

  expect(res.status).toBe(500);
  expect(captureException).toHaveBeenCalledTimes(1);
  const eventId = captureException.mock.results[0].value as string;
  expect(body.errorId).toBe(eventId);
  expect(body.error).toBe(
    `Something went wrong. Please try again. Reference: ${eventId.slice(0, 8)}.`,
  );
  expect(JSON.stringify(body)).not.toMatch(/prisma/i);
  // The failure is the route's own Prisma read, not a harness error before it.
  expect(failingRead).toHaveBeenCalled();
  expect(captureException.mock.calls[0][0]).toMatchObject({
    message: expect.stringContaining("prisma.consultantProfile.findMany"),
  });
});
