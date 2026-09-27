/**
 * @jest-environment node
 */

/**
 * #789 / #1851 decision 6 — privilege-escalation guard on invitations. Only an
 * OWNER invites an OWNER, MAINTAINER or BILLING_ADMIN (the accept route trusts
 * the stored role), so a MAINTAINER is refused with 403 before any write,
 * while an OWNER passes the guard. The members POST direct-add is retired
 * (#1846): joining is invite + accept only.
 */

import { POST as membersPost } from "../../app/api/organizations/[orgId]/members/route";
import { POST as invitationsPost } from "../../app/api/organizations/[orgId]/invitations/route";
import { requireOrgAccess } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { applyRateLimit } from "@/lib/rate-limit";

jest.mock("../../lib/prisma", () => {
  const tx = { membership: { findFirst: jest.fn() } };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  orgInviteLimiter: {},
}));

const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;
const mockedMemberFind = (prisma as unknown as {
  membership: { findFirst: jest.Mock };
}).membership.findFirst;
const mockedApplyRateLimit = applyRateLimit as jest.Mock;

function access(role: string) {
  return {
    error: null,
    session: { user: { id: "u-actor", email: "actor@test.com" } },
    member: { id: "m-actor", role },
    org: {
      id: "org-1",
      name: "Acme",
      canHost: true,
      canSponsor: true,
      status: "ACTIVE",
    },
  };
}

function req(body: unknown) {
  return new Request("http://localhost/api/organizations/org-1/invitations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as never;
}

const params = { params: Promise.resolve({ orgId: "org-1" }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockedApplyRateLimit.mockResolvedValue(null);
});

describe("OWNER-only roles on invitations", () => {
  it.each(["OWNER", "MAINTAINER", "BILLING_ADMIN"])(
    "rejects a MAINTAINER inviting role=%s with 403 and no read",
    async (role) => {
      mockedRequireOrgAccess.mockResolvedValue(access("MAINTAINER"));
      const res = await invitationsPost(
        req({ email: "victim@test.com", role }),
        params,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("ROLE_REQUIRES_OWNER");
      expect(mockedMemberFind).not.toHaveBeenCalled();
    },
  );

  it("lets an OWNER past the guard (proceeds to the member lookup)", async () => {
    mockedRequireOrgAccess.mockResolvedValue(access("OWNER"));
    mockedMemberFind.mockResolvedValue({ status: "ACTIVE" });
    const res = await invitationsPost(
      req({ email: "already@test.com", role: "MAINTAINER" }),
      params,
    );
    // Not the 403 escalation block: the helper reached the existing-member
    // check and refused an invitation for someone already in the org.
    expect(res.status).toBe(409);
    expect(mockedMemberFind).toHaveBeenCalled();
  });

  it("the members POST direct-add is retired", async () => {
    const res = membersPost();
    expect(res.status).toBe(405);
    expect((await res.json()).code).toBe("USE_INVITATIONS");
  });
});
