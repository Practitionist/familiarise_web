/**
 * @jest-environment node
 */

/**
 * An admin's edit of another user's profile needs a fresh session and writes
 * one operator audit row; the owner's own edit needs neither.
 */

const STALE = new Date("2020-01-01T00:00:00Z");
const caller = {
  current: {
    user: { id: "u-admin", role: "ADMIN" },
    session: { createdAt: STALE },
  },
};
const mockUserUpdate = jest.fn(async () => ({ id: "u-learner" }));
const mockOpsCreate = jest.fn(async () => ({ id: "ops-1" }));
const mockPersist = jest.fn(async () => undefined);
const tx = {
  user: { update: mockUserUpdate },
  opsActionLog: { create: mockOpsCreate },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { update: (...a: unknown[]) => mockUserUpdate(...(a as [])) },
    consultantProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) =>
      run(tx),
    ),
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({ session: caller.current })),
}));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/data/user-details", () => ({ getUserDetails: jest.fn() }));
jest.mock("../../utils/onboarding-server", () => ({
  persistProfessionalBackground: (...a: unknown[]) => mockPersist(...(a as [])),
}));
jest.mock("../../lib/compliance/erasure/scrub-user", () => ({}));
jest.mock("../../lib/novu/subscriber", () => ({}));
jest.mock("../../lib/data/public-cache", () => ({
  purgeExpertSurfaces: jest.fn(),
}));

import { NextRequest } from "next/server";
import { PATCH, PUT } from "@/app/api/user/[id]/route";

const call = (method: "PUT" | "PATCH", body: unknown) =>
  (method === "PUT" ? PUT : PATCH)(
    new NextRequest("https://x.test/api/user/u-learner", {
      method,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "u-learner" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  caller.current = {
    user: { id: "u-admin", role: "ADMIN" },
    session: { createdAt: STALE },
  };
});

it.each(["PUT", "PATCH"] as const)(
  "refuses an admin %s of another user without a fresh session",
  async (method) => {
    const res = await call(method, { name: "Asha" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("REAUTH_REQUIRED");
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockOpsCreate).not.toHaveBeenCalled();
  },
);

it("audits a fresh admin edit in the same transaction as the write", async () => {
  caller.current.session.createdAt = new Date();
  const res = await call("PUT", { name: "Asha", city: "" });
  expect(res.status).toBe(200);
  expect(mockOpsCreate).toHaveBeenCalledWith({
    data: expect.objectContaining({
      actorUserId: "u-admin",
      surface: "users.moderate",
      action: "user.profile.update",
      targetKind: "User",
      targetId: "u-learner",
      after: { fields: ["name"] },
    }),
    select: { id: true },
  });
  expect(mockUserUpdate).toHaveBeenCalled();
});

it("lets the owner edit their own profile on an old session, unaudited", async () => {
  caller.current = {
    user: { id: "u-learner", role: "CONSULTEE" },
    session: { createdAt: STALE },
  };
  const res = await call("PATCH", { workExperiences: [] });
  expect(res.status).toBe(200);
  expect(mockPersist).toHaveBeenCalled();
  expect(mockOpsCreate).not.toHaveBeenCalled();
});
