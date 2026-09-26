import {
  resolveDashboardFacets,
  type DashboardFacetInput,
} from "@/lib/labels/personal-dashboard";

const base: DashboardFacetInput = {
  role: "CONSULTEE",
  memberships: [],
};

const keys = (input: DashboardFacetInput) => {
  const f = resolveDashboardFacets(input);
  return {
    you: f.you.map((x) => x.label),
    organizations: f.organizations.map((x) => x.label),
    platform: f.platform.map((x) => x.label),
    create: f.actions.createOrganizationHref,
    becomeExpert: f.actions.becomeExpertHref,
  };
};

// #1527 Q1 — the switcher's facet groups per identity mix.
describe("resolveDashboardFacets", () => {
  it("consultee only: Client, can become an expert", () => {
    expect(
      keys({ ...base, consulteeProfileId: "ce-1", canBecomeExpert: true }),
    ).toEqual({
      you: ["Client"],
      organizations: [],
      platform: [],
      create: null,
      becomeExpert: "/form/onboarding?add=CONSULTANT",
    });
  });

  it("consultant only: Expert, nothing to add", () => {
    expect(
      keys({ ...base, role: "CONSULTANT", consultantProfileId: "cp-1" }),
    ).toEqual({
      you: ["Expert"],
      organizations: [],
      platform: [],
      create: null,
      becomeExpert: null,
    });
  });

  it("consultant who also booked: Expert and Client", () => {
    const f = resolveDashboardFacets({
      ...base,
      role: "CONSULTANT",
      consultantProfileId: "cp-1",
      consulteeProfileId: "ce-1",
    });
    expect(f.you.map((x) => [x.label, x.href])).toEqual([
      ["Expert", "/dashboard/consultant/cp-1/home"],
      ["Client", "/dashboard/consultee/ce-1/home"],
    ]);
  });

  it("member of two orgs: bare org links, humanized roles, pending badge", () => {
    const f = resolveDashboardFacets({
      ...base,
      consulteeProfileId: "ce-1",
      memberships: [
        {
          organizationId: "o1",
          organizationName: "Acme",
          role: "LEARNER",
          status: "ACTIVE",
          orgStatus: "ACTIVE",
        },
        {
          organizationId: "o2",
          organizationName: "Globex",
          role: "BILLING_ADMIN",
          status: "PENDING",
          orgStatus: "ACTIVE",
        },
      ],
    });
    expect(
      f.organizations.map((o) => [o.href, o.roleLabel, o.statusLabel]),
    ).toEqual([
      ["/dashboard/organization/o1", "Learner", null],
      ["/dashboard/organization/o2", "Billing admin", "Pending"],
    ]);
  });

  it("org status outranks membership status in the badge", () => {
    const f = resolveDashboardFacets({
      ...base,
      memberships: [
        {
          organizationId: "o3",
          organizationName: "Initech",
          role: "OWNER",
          status: "ACTIVE",
          orgStatus: "PENDING_VERIFICATION",
        },
      ],
    });
    expect(f.organizations[0].statusLabel).toBe("Pending verification");
  });

  it("ORG_WORKSPACE: All organizations, create in the workspace", () => {
    expect(
      keys({
        ...base,
        role: "ORG_WORKSPACE",
        orgWorkspaceProfileId: "ow-1",
        canBecomeExpert: true,
      }),
    ).toEqual({
      you: [],
      organizations: ["All organizations"],
      platform: [],
      create: "/dashboard/org-workspace/ow-1/create",
      becomeExpert: "/form/onboarding?add=CONSULTANT",
    });
  });

  it("ADMIN: Admin platform facet", () => {
    expect(keys({ ...base, role: "ADMIN" })).toMatchObject({
      platform: ["Admin"],
      becomeExpert: null,
    });
  });

  it("STAFF: Staff platform facet at their own tree", () => {
    const f = resolveDashboardFacets({
      ...base,
      role: "STAFF",
      staffProfileId: "sp-1",
    });
    expect(f.platform.map((x) => [x.label, x.href])).toEqual([
      ["Staff", "/dashboard/staff/tickets"],
    ]);
    expect(f.actions.becomeExpertHref).toBeNull();
  });
});
