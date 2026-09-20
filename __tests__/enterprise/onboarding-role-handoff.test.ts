/**
 * @jest-environment node
 */

/**
 * ORG_WORKSPACE onboarding handoff: the role is committed on the User row at
 * step 0 so the create-org wizard's `POST /api/organizations` authorizes.
 * These cover the revert that runs when the user backs out of that wizard —
 * without it they are stranded on ORG_WORKSPACE with onboardingCompleted false.
 */

// Factories are inlined rather than closing over module-level consts: the
// `import`s below are hoisted above them, so a captured const is still in TDZ
// when the action module first requires these.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { updateMany: jest.fn(), update: jest.fn() },
    orgWorkspaceProfile: { upsert: jest.fn() },
    membership: { findFirst: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

// The action module also exports the full onboarding writer; stubbing it keeps
// jest away from that import chain, which these tests never exercise.
jest.mock("../../utils/onboarding-server", () => ({
  processOnboardingData: jest.fn(),
}));

import {
  completeOrgWorkspaceOnboardingAction,
  resetOnboardingRoleAction,
  setOnboardingRoleAction,
} from "../../actions/forms/onboarding.action";
import { getSession } from "../../lib/auth-server";
import prisma from "../../lib/prisma";
import { UserRole } from "@prisma/client";

const mockGetSession = getSession as unknown as jest.Mock;
const mockUpdateMany = prisma.user.updateMany as unknown as jest.Mock;
const mockUserUpdate = prisma.user.update as unknown as jest.Mock;
const mockProfileUpsert =
  prisma.orgWorkspaceProfile.upsert as unknown as jest.Mock;
const mockMembershipFindFirst =
  prisma.membership.findFirst as unknown as jest.Mock;

const USER_ID = "user-1";

describe("resetOnboardingRoleAction", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to reset a different user's role", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "someone-else" } });

    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: false,
      error: "Forbidden",
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("reverts to the signup default only while the handoff is provisional", async () => {
    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: true,
      reverted: true,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        role: "ORG_WORKSPACE",
        onboardingCompleted: { not: true },
        memberships: { none: {} },
      },
      // Unlinks the profile created at handoff (row kept for reuse).
      data: { role: "CONSULTEE", orgWorkspaceProfileId: null },
    });
  });

  it("reports no revert when the guard matches nothing (real org owner)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: true,
      reverted: false,
    });
  });
});

describe("setOnboardingRoleAction operator-profile close", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUserUpdate.mockResolvedValue({});
    mockProfileUpsert.mockResolvedValue({ id: "ows-1" });
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("creates + links the OrgWorkspaceProfile at handoff (no half-onboarded window)", async () => {
    await expect(
      setOnboardingRoleAction(USER_ID, UserRole.ORG_WORKSPACE, { name: "Ada" }),
    ).resolves.toEqual({ success: true });

    expect(mockProfileUpsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      create: { userId: USER_ID },
      update: {},
      select: { id: true },
    });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, orgWorkspaceProfileId: null },
      data: { orgWorkspaceProfileId: "ows-1" },
    });
  });

  it("still refuses privileged roles at the allowlist", async () => {
    await expect(
      setOnboardingRoleAction(USER_ID, UserRole.ADMIN, {}),
    ).resolves.toEqual({ success: false, error: "Forbidden" });
    expect(mockProfileUpsert).not.toHaveBeenCalled();
  });
});

describe("completeOrgWorkspaceOnboardingAction membership gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockMembershipFindFirst.mockResolvedValue({ id: "m-1" });
    mockUserUpdate.mockResolvedValue({});
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(completeOrgWorkspaceOnboardingAction(USER_ID)).resolves.toEqual(
      {
        success: false,
        error: "Unauthorized",
      },
    );
    expect(mockMembershipFindFirst).not.toHaveBeenCalled();
  });

  it("refuses to flip the flag with no live OWNER membership (crafted/replayed call)", async () => {
    mockMembershipFindFirst.mockResolvedValue(null);

    await expect(completeOrgWorkspaceOnboardingAction(USER_ID)).resolves.toEqual(
      {
        success: false,
        error: "No organization found. Create your organization first.",
      },
    );
    expect(mockMembershipFindFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, role: "OWNER", status: "ACTIVE" },
      select: { id: true },
    });
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("flips the flag once the owner membership exists", async () => {
    await expect(completeOrgWorkspaceOnboardingAction(USER_ID)).resolves.toEqual(
      { success: true },
    );
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { onboardingCompleted: true },
    });
  });
});
