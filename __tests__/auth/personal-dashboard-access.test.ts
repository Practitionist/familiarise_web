/**
 * @jest-environment node
 */

/**
 * requirePersonalProfileAccess decides from the session user alone: the owner
 * passes, an ADMIN/STAFF inspects, anyone else is sent back to /dashboard, and
 * it issues no database read of its own.
 */

const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));
jest.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get() {
        throw new Error("the guard must not query the database");
      },
    },
  ),
}));

import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

function session(user: Record<string, unknown>) {
  mockGetSession.mockResolvedValue({ user: { id: "u1", ...user } });
}

beforeEach(() => mockGetSession.mockReset());

describe("requirePersonalProfileAccess", () => {
  it("lets a learner open their own consultee profile", async () => {
    session({ role: "CONSULTEE", consulteeProfileId: "ce1" });
    await expect(
      requirePersonalProfileAccess("consultee", "ce1"),
    ).resolves.toEqual({ userId: "u1", isInspecting: false });
  });

  it("lets an expert open their own consultant profile", async () => {
    session({ role: "CONSULTANT", consultantProfileId: "ca1" });
    await expect(
      requirePersonalProfileAccess("consultant", "ca1"),
    ).resolves.toEqual({ userId: "u1", isInspecting: false });
  });

  it.each(["ADMIN", "STAFF"])(
    "lets %s inspect another profile read-only",
    async (role) => {
      session({ role });
      await expect(
        requirePersonalProfileAccess("consultee", "someone-else"),
      ).resolves.toEqual({ userId: "u1", isInspecting: true });
    },
  );

  it("does not mark an operator opening their own profile as inspecting", async () => {
    session({ role: "ADMIN", consulteeProfileId: "ce1" });
    await expect(
      requirePersonalProfileAccess("consultee", "ce1"),
    ).resolves.toEqual({ userId: "u1", isInspecting: false });
  });

  it("sends a non-owner back to the dashboard router", async () => {
    session({ role: "CONSULTEE", consulteeProfileId: "ce1" });
    await expect(
      requirePersonalProfileAccess("consultee", "ce2"),
    ).rejects.toThrow("REDIRECT /dashboard");
  });

  it("does not accept the other profile kind's id as ownership", async () => {
    session({ role: "CONSULTANT", consultantProfileId: "ca1" });
    await expect(
      requirePersonalProfileAccess("consultee", "ca1"),
    ).rejects.toThrow("REDIRECT /dashboard");
  });

  it("sends a signed-out visitor to sign-in", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(
      requirePersonalProfileAccess("consultee", "ce1"),
    ).rejects.toThrow("REDIRECT /auth/signin");
  });

  it("refuses a banned session even for the owner", async () => {
    session({ role: "CONSULTEE", consulteeProfileId: "ce1", banned: true });
    await expect(
      requirePersonalProfileAccess("consultee", "ce1"),
    ).rejects.toThrow("REDIRECT /auth/signin");
  });
});
