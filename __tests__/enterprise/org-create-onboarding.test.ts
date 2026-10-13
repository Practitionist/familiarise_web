/**
 * @jest-environment node
 */

/**
 * A first-time ORG_WORKSPACE owner is onboarded inside the org-create
 * transaction: the CAS claim (role, DOB, consent, onboardingCompleted) runs
 * first, and a lost claim creates no organization.
 */

const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: () => mockRequireApiAuth(),
}));
jest.mock("../../lib/data/org-workspace", () => ({
  getOperatorOrganizations: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  attemptOnboardingEmail: jest.fn(),
  stageOrgCreatedEmail: jest.fn(async () => null),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/enterprise/feature-flag", () => ({
  isHostOrgsEnabled: () => false,
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  ensureConsentPurposes: jest.fn(),
}));

const calls: string[] = [];
const tx = {
  user: {
    updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
      calls.push("orgWorkspaceProfileId" in args.data ? "link" : "claim");
      return { count: 1 };
    }),
  },
  organization: {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async (args: { data: { id: string; name: string } }) => {
      calls.push("org");
      return { ...args.data, slug: "acme", canSponsor: false, canHost: false };
    }),
    update: jest.fn(),
  },
  billingAccount: { create: jest.fn(async () => ({ id: "ba_1" })) },
  membership: {
    create: jest.fn(async () => {
      calls.push("membership");
      return { id: "m_1" };
    }),
  },
  orgWorkspaceProfile: { upsert: jest.fn(async () => ({ id: "owp_1" })) },
  orgAuditLog: { create: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { ensureConsentPurposes } from "../../lib/compliance/dpdp";
import { POST } from "../../app/api/organizations/route";

const mockTransaction = prisma.$transaction as unknown as jest.Mock;
const mockEnsureConsent = ensureConsentPurposes as unknown as jest.Mock;

const newUser = {
  id: "user-1",
  role: "CONSULTEE",
  onboardingCompleted: false,
};

const onboarding = {
  name: "Ada Owner",
  dateOfBirth: "1990-06-15",
  termsAccepted: true,
  privacyAccepted: true,
};

function createRequest(body: Record<string, unknown>) {
  return new NextRequest("https://x.test/api/organizations", {
    method: "POST",
    body: JSON.stringify({
      name: "Acme Learning",
      billingEmail: "billing@acme.test",
      ...body,
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockRequireApiAuth.mockResolvedValue({ session: { user: newUser } });
  mockTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) =>
    fn(tx),
  );
});

describe("POST /api/organizations onboarding a first-time owner", () => {
  it("claims onboarding first, then creates org, membership and profile link in the same tx", async () => {
    const res = await POST(
      createRequest({
        canSponsor: true,
        canHost: false,
        gstStateCode: "29",
        onboarding: { ...onboarding, marketingConsent: true },
      }),
    );
    expect(res.status).toBe(201);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["claim", "org", "membership", "link"]);

    const claim = tx.user.updateMany.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where).toEqual({
      id: "user-1",
      onboardingCompleted: { not: true },
    });
    expect(claim.data).toMatchObject({
      role: "ORG_WORKSPACE",
      onboardingCompleted: true,
      name: "Ada Owner",
    });
    expect(claim.data.dateOfBirth).toBeInstanceOf(Date);
    expect(claim.data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(mockEnsureConsent).toHaveBeenCalledWith(
      tx,
      "user-1",
      expect.arrayContaining(["PRIMARY_PROCESSING", "MARKETING_COMMS"]),
    );
  });

  it("a lost claim (second tab, already onboarded) is 409 and creates no org", async () => {
    tx.user.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(
      createRequest({
        canSponsor: true,
        canHost: false,
        gstStateCode: "29",
        onboarding,
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_ONBOARDED");
    expect(tx.organization.create).not.toHaveBeenCalled();
  });

  it("refuses the onboarding block without consent", async () => {
    const res = await POST(
      createRequest({
        canSponsor: true,
        canHost: false,
        gstStateCode: "29",
        onboarding: { ...onboarding, termsAccepted: false },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("refuses an under-18 owner", async () => {
    const minor = new Date();
    minor.setUTCFullYear(minor.getUTCFullYear() - 15);
    const res = await POST(
      createRequest({
        canSponsor: true,
        canHost: false,
        gstStateCode: "29",
        onboarding: {
          ...onboarding,
          dateOfBirth: minor.toISOString().slice(0, 10),
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("a not-yet-onboarded CONSULTEE without the onboarding block cannot create an org", async () => {
    const res = await POST(
      createRequest({ canSponsor: true, canHost: false, gstStateCode: "29" }),
    );
    expect(res.status).toBe(403);
  });

  it("an onboarded CONSULTANT cannot turn into an org owner", async () => {
    mockRequireApiAuth.mockResolvedValue({
      session: {
        user: { id: "user-2", role: "CONSULTANT", onboardingCompleted: true },
      },
    });
    const res = await POST(
      createRequest({
        canSponsor: true,
        canHost: false,
        gstStateCode: "29",
        onboarding,
      }),
    );
    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
