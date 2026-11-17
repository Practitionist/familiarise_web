/**
 * @jest-environment node
 */

/** A role the back-office matrix refuses gets a 403 carrying `code: "FORBIDDEN"`. */
jest.mock("../../lib/auth-session-lookup", () => ({
  lookupSession: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({}));
jest.mock("../../lib/observability/identity", () => ({
  setSentryIdentityFromSession: jest.fn(),
  setSentryOrgContext: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { lookupSession } from "../../lib/auth-session-lookup";
import { requireBackofficeSurface } from "../../lib/auth-helpers";

const mockLookup = lookupSession as jest.MockedFunction<typeof lookupSession>;

it("refuses a consultant with a coded 403", async () => {
  mockLookup.mockResolvedValue({
    kind: "found",
    session: {
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", role: "CONSULTANT", banned: false },
    },
  } as unknown as Awaited<ReturnType<typeof lookupSession>>);

  const { error } = await requireBackofficeSurface("appointments.manage");

  expect(error?.status).toBe(403);
  expect(await error?.json()).toEqual({
    error: "Your role can't open this part of the back office.",
    code: "FORBIDDEN",
  });
});
