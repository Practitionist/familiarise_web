/**
 * @jest-environment node
 */

/**
 * #1527 decision 6 — a SUSPENDED member keeps Appointments › Mine, their own
 * appointment detail and Join for sessions already booked; everything else,
 * including every grant-gated surface and new org-funded bookings, is refused.
 */

import { readFileSync } from "fs";
import { join } from "path";

const mockOrgFindUnique = jest.fn();
const mockMembershipFindUnique = jest.fn();

jest.mock("../../lib/auth-session-lookup", () => ({
  __esModule: true,
  lookupSession: async () => ({
    kind: "found",
    session: { user: { id: "u1", role: "USER" } },
  }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: { findUnique: (...a: unknown[]) => mockOrgFindUnique(...a) },
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
  },
}));

import { requireOrgAccess } from "@/lib/auth-helpers";
import { buildOrganizationNav } from "@/lib/dashboard/nav/organization";
import { flattenNav } from "@/lib/dashboard/nav/types";
import { deriveActionCenter } from "@/lib/enterprise/org-activation";
import {
  isSuspendedInFundingOrg,
  membershipSuspendedResponse,
} from "@/lib/enterprise/suspended-member-sessions";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const DASH = "app/dashboard/organization/[orgId]";

beforeEach(() => {
  mockOrgFindUnique.mockResolvedValue({
    id: "o",
    status: "ACTIVE",
    canSponsor: true,
    canHost: true,
    billingAccount: null,
  });
  mockMembershipFindUnique.mockResolvedValue({
    id: "m",
    role: "OWNER",
    status: "SUSPENDED",
  });
});

describe("requireOrgAccess with a SUSPENDED membership", () => {
  it("admits only callers that opt in with allowSuspended", async () => {
    expect((await requireOrgAccess("o")).error?.status).toBe(403);
    const admitted = await requireOrgAccess("o", { allowSuspended: true });
    if (admitted.error) throw new Error("expected the suspended member in");
    expect(admitted.member.status).toBe("SUSPENDED");
  });

  it("never passes a permission gate, even for an OWNER", async () => {
    const gate = {
      allowSuspended: true,
      permission: "operations.read",
    } as const;
    expect((await requireOrgAccess("o", gate)).error?.status).toBe(403);
  });

  it("still refuses REMOVED even with allowSuspended", async () => {
    mockMembershipFindUnique.mockResolvedValue({
      id: "m",
      role: "LEARNER",
      status: "REMOVED",
    });
    const res = await requireOrgAccess("o", { allowSuspended: true });
    expect(res.error?.status).toBe(403);
  });
});

describe("where allowSuspended is used", () => {
  it("is limited to org details, Appointments, the member's own detail and the Library", () => {
    const users = [
      "app/api/organizations/[orgId]/route.ts",
      "lib/data/org-details-server.ts",
      `${DASH}/appointments/page.tsx`,
      `${DASH}/appointments/[appointmentId]/page.tsx`,
      `${DASH}/documents/page.tsx`,
      `${DASH}/recordings/page.tsx`,
      "app/api/organizations/[orgId]/documents/route.ts",
      "app/api/organizations/[orgId]/recordings/route.ts",
    ];
    for (const file of users) expect(read(file)).toContain("allowSuspended");
  });

  it("offers a suspended member only Mine — never Everyone or Unscheduled", () => {
    const src = read(`${DASH}/appointments/page.tsx`);
    expect(src).toContain(
      'if (active && hasOrgPermission(role, "operations.read"))',
    );
    expect(src).toContain(
      'if (active && hasOrgPermission(role, "appointments.unscheduled.read"))',
    );
  });

  it("serves the detail read-only and 404s the operator branch", () => {
    const src = read(`${DASH}/appointments/[appointmentId]/page.tsx`);
    expect(src).toContain("readOnly={suspended}");
    expect(src).toContain("if (suspended) notFound();");
  });

  it("Join is participant-based, with no org-membership gate to trip", () => {
    const join = read("app/api/meetings/[meetingId]/join/route.ts");
    expect(join).not.toContain("requireOrgAccess");
  });

  it("org-funded checkout refuses a non-ACTIVE membership (typed)", () => {
    const checkout = read("lib/payments/operations/checkout.ts");
    expect(checkout).toContain('callerMembership.status !== "ACTIVE"');
    expect(checkout).toContain('code: "ORG_MEMBERSHIP_REQUIRED"');
  });
});

it("a suspended learner can't cancel or reschedule an org-funded booking (#1527 3c)", async () => {
  expect(await isSuspendedInFundingOrg("u1", "o")).toBe(true);
  expect(await isSuspendedInFundingOrg("u1", null)).toBe(false);
  const res = membershipSuspendedResponse();
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("MEMBERSHIP_SUSPENDED");
  const API = "app/api/appointments/[appointmentId]";
  // Refused before any quote or refund logic runs.
  const cancel = read(`${API}/cancel/route.ts`);
  expect(cancel.indexOf("isSuspendedInFundingOrg(")).toBeGreaterThan(-1);
  expect(cancel.indexOf("isSuspendedInFundingOrg(")).toBeLessThan(
    cancel.indexOf("hasActiveDisputeForAppointment(appointmentId)"),
  );
  const preview = read(`${API}/cancel/preview/route.ts`);
  expect(preview.indexOf("isSuspendedInFundingOrg(")).toBeGreaterThan(-1);
  expect(preview.indexOf("isSuspendedInFundingOrg(")).toBeLessThan(
    preview.indexOf("await quoteIndividualBooking("),
  );
  expect(read(`${API}/reschedule/route.ts`)).toContain(
    "throw membershipSuspendedError()",
  );
  expect(read(`${API}/reschedule/respond/route.ts`)).toContain(
    "return membershipSuspendedResponse()",
  );
});

it("the suspended nav is Overview, Appointments and the Library", () => {
  const nav = buildOrganizationNav({
    orgId: "o",
    role: "OWNER",
    canSponsor: true,
    canHost: true,
    consultantProfileId: null,
    suspended: true,
  });
  expect(flattenNav(nav).map((i) => i.path)).toEqual([
    "home",
    "appointments",
    "documents",
    "recordings",
  ]);
});

it("operators get an action item linking to those sessions", () => {
  const items = deriveActionCenter(
    {
      status: "ACTIVE",
      walletLowBalancePaise: null,
      creditPoolMaxUtilizationPct: null,
      suspendedMemberUpcomingCount: 2,
    } as never,
    "o",
  );
  const item = items.find((i) => i.key === "suspended-member-sessions");
  expect(item?.title).toBe("2 upcoming sessions for suspended members");
  expect(item?.ctaHref).toBe(
    "/dashboard/organization/o/appointments?tab=everyone&members=suspended",
  );
});
