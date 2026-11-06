/**
 * @jest-environment node
 */
const mockSession = jest.fn();
const mockMemberships = jest.fn();

jest.mock("@/lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("@/lib/dashboard/switcher-memberships", () => ({
  findSwitcherMemberships: (id: string, all: boolean) =>
    mockMemberships(id, all),
}));

import { GET } from "@/app/api/user/dashboard-facets/route";
import { DashboardFacetsResponseSchema } from "@/lib/navigation/dashboard-facets-schema";

const ORG_ROW = {
  organizationId: "org1",
  role: "OWNER",
  status: "ACTIVE",
  organization: {
    name: "Acme",
    status: "ACTIVE",
    brandingProfile: { logo: null },
  },
};

describe("GET /api/user/dashboard-facets", () => {
  beforeEach(() => {
    mockSession.mockReset();
    mockMemberships.mockReset();
    mockMemberships.mockResolvedValue([]);
  });

  it("answers 401 when signed out", async () => {
    mockSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("lists the org facet for an expert who owns an organization", async () => {
    mockSession.mockResolvedValue({
      user: {
        id: "u1",
        role: "CONSULTANT",
        onboardingCompleted: true,
        consultantProfileId: "c1",
      },
    });
    mockMemberships.mockResolvedValue([ORG_ROW]);
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = DashboardFacetsResponseSchema.parse(await res.json());
    expect(body.facets.map((f) => f.key)).toEqual(["expert", "org:org1"]);
    expect(body.facets[1]).toEqual({
      kind: "organization",
      key: "org:org1",
      label: "Acme",
      href: "/dashboard/organization/org1",
    });
    expect(mockMemberships).toHaveBeenCalledWith("u1", true);
  });

  it.each([
    ["ADMIN", ["admin", "staff"]],
    ["STAFF", ["staff"]],
  ])("lists the %s facet next to personal profiles", async (role, platform) => {
    mockSession.mockResolvedValue({
      user: {
        id: "u2",
        role,
        onboardingCompleted: true,
        consultantProfileId: "c2",
        consulteeProfileId: "l2",
        staffProfileId: "s2",
      },
    });
    const body = DashboardFacetsResponseSchema.parse(
      await (await GET()).json(),
    );
    expect(body.facets.map((f) => f.kind)).toEqual([
      "expert",
      "client",
      ...platform,
    ]);
  });
});
