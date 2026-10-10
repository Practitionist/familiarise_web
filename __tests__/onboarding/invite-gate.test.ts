/**
 * @jest-environment node
 */

/**
 * One onboarding gate for invitees: accept refuses a not-yet-onboarded user
 * (every role) with a link to the gate; once the gate has run, the default
 * CONSULTEE row with no profile passes `requireOnboarded`, and a new EXPERT
 * invitee can reach add mode. Org members never land in the B2C wizard.
 */

const mockLookupSession = jest.fn();
jest.mock("../../lib/auth-session-lookup", () => ({
  lookupSession: (...a: unknown[]) => mockLookupSession(...a),
  SessionLookupFailedError: class extends Error {},
}));
const mockHeaders = jest.fn(() => new Headers());
jest.mock("next/headers", () => ({
  headers: async () => mockHeaders(),
}));
jest.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
jest.mock("../../lib/observability/identity", () => ({
  setSentryIdentityFromSession: jest.fn(),
}));
jest.mock("../../lib/profiles/ensure-org-workspace-profile", () => ({
  ensureOrgWorkspaceProfile: jest.fn(async () => "owp_1"),
}));
const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: () => mockRequireApiAuth(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  checkConsent: jest.fn(async () => true),
  ensureConsentPurposes: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInviteAccepted: jest.fn(async () => []),
}));
jest.mock("../../lib/novu", () => ({ attemptTrigger: jest.fn() }));
jest.mock("../../lib/email", () => ({
  attemptOnboardingEmail: jest.fn(),
  stageOrgWelcomeEmail: jest.fn(async () => null),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(),
}));
jest.mock("../../lib/api/organizations/membership-transitions", () => ({
  applyMembershipRoleEffects: jest.fn(),
  recomputeConsultantIsIndependent: jest.fn(),
}));
jest.mock("../../lib/enterprise/transitions", () => ({
  transitionMembership: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    invitation: { findUnique: jest.fn() },
    membership: { findFirst: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { POST as acceptInvitation } from "../../app/api/organizations/invitations/accept/route";
import { requireNotOnboarded, requireOnboarded } from "../../lib/auth-guard";
import { canAddConsultantIdentity } from "../../utils/onboarding-shared";

const mockInvitation = prisma.invitation.findUnique as unknown as jest.Mock;
const mockMembership = prisma.membership.findFirst as unknown as jest.Mock;
const mockTransaction = prisma.$transaction as unknown as jest.Mock;

const EMAIL = "new@example.com";

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-new",
    email: EMAIL,
    emailVerified: true,
    name: "New Person",
    role: "CONSULTEE",
    banned: false,
    onboardingCompleted: false,
    consultantProfileId: null,
    consulteeProfileId: null,
    staffProfileId: null,
    orgWorkspaceProfileId: null,
    ...overrides,
  };
}

function acceptRequest() {
  return new NextRequest(
    "https://x.test/api/organizations/invitations/accept",
    {
      method: "POST",
      body: JSON.stringify({ invitationId: "inv_1" }),
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHeaders.mockImplementation(() => new Headers());
  mockMembership.mockResolvedValue(null);
});

describe.each(["MANAGER", "EXPERT"])(
  "a brand-new user invited as %s",
  (role) => {
    beforeEach(() => {
      mockInvitation.mockResolvedValue({
        id: "inv_1",
        organizationId: "org_1",
        email: EMAIL,
        role,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    });

    it("is sent to the gate by accept, which writes nothing", async () => {
      mockRequireApiAuth.mockResolvedValue({
        session: { user: sessionUser() },
      });
      const res = await acceptInvitation(acceptRequest());
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ONBOARDING_REQUIRED");
      expect(body.gateHref).toBe(
        `/onboarding/gate?callbackUrl=${encodeURIComponent("/organizations/invite/inv_1")}`,
      );
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("passes requireOnboarded after the gate, with no consultee profile", async () => {
      mockLookupSession.mockResolvedValue({
        kind: "session",
        session: {
          session: { id: "s1" },
          user: sessionUser({ onboardingCompleted: true }),
        },
      });
      await expect(requireOnboarded()).resolves.toMatchObject({
        user: { id: "user-new" },
      });
    });
  },
);

it("a brand-new EXPERT invitee reaches add mode once the gate has run", () => {
  // The invite page's NOT_A_CONSULTANT link leads into the wizard's add mode.
  expect(
    canAddConsultantIdentity(sessionUser({ onboardingCompleted: true })),
  ).toBe(true);
  expect(canAddConsultantIdentity(sessionUser())).toBe(false);
});

describe("org members never run the B2C wizard", () => {
  beforeEach(() => {
    mockLookupSession.mockResolvedValue({
      kind: "session",
      session: { session: { id: "s1" }, user: sessionUser() },
    });
    mockMembership.mockResolvedValue({ id: "m_1" });
  });

  it("requireOnboarded sends an SSO JIT member to the gate", async () => {
    mockHeaders.mockImplementation(
      () => new Headers({ "x-pathname": "/dashboard/organization/org_1/home" }),
    );
    await expect(requireOnboarded()).rejects.toThrow(
      `REDIRECT /onboarding/gate?callbackUrl=${encodeURIComponent("/dashboard/organization/org_1/home")}`,
    );
  });

  it("the wizard guard redirects a member to the gate, keeping callbackUrl", async () => {
    mockHeaders.mockImplementation(
      () =>
        new Headers({
          "x-pathname": "/form/onboarding?callbackUrl=%2Fdashboard",
        }),
    );
    await expect(requireNotOnboarded()).rejects.toThrow(
      `REDIRECT /onboarding/gate?callbackUrl=${encodeURIComponent("/dashboard")}`,
    );
  });

  it("a user with no membership still goes to the wizard", async () => {
    mockMembership.mockResolvedValue(null);
    await expect(requireOnboarded()).rejects.toThrow(
      "REDIRECT /form/onboarding",
    );
  });
});

describe("the shared isFullyOnboarded predicate in the guards", () => {
  it("sends an onboarded CONSULTANT without a profile to the missing-profile notice", async () => {
    mockLookupSession.mockResolvedValue({
      kind: "session",
      session: {
        session: { id: "s1" },
        user: sessionUser({ role: "CONSULTANT", onboardingCompleted: true }),
      },
    });
    await expect(requireOnboarded()).rejects.toThrow(
      "REDIRECT /form/onboarding?error=missing_profile",
    );
  });

  it("keeps a fully onboarded user out of the wizard", async () => {
    mockLookupSession.mockResolvedValue({
      kind: "session",
      session: {
        session: { id: "s1" },
        user: sessionUser({ onboardingCompleted: true }),
      },
    });
    await expect(requireNotOnboarded()).rejects.toThrow("REDIRECT /dashboard");
  });
});
