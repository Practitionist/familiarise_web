import {
  backofficeLandingHref,
  resolveDashboardLanding,
} from "@/lib/dashboard/landing";
import { resolveGoHref } from "@/lib/dashboard/go";

// #1527 §6 — where /dashboard lands and how /dashboard/go resolves a viewer.
describe("resolveDashboardLanding", () => {
  it("routes the back office: admin to Home, staff to Tickets (Q12)", () => {
    expect(resolveDashboardLanding({ role: "ADMIN" })).toBe(
      "/dashboard/admin/home",
    );
    expect(backofficeLandingHref("STAFF")).toBe("/dashboard/staff/tickets");
  });

  it("sends ORG_WORKSPACE to its default org only while an ACTIVE member", () => {
    const user = {
      role: "ORG_WORKSPACE",
      orgWorkspaceProfileId: "ow-1",
      organizationMemberships: [{ organizationId: "o1", role: "OWNER" }],
    };
    expect(resolveDashboardLanding(user, { workspaceLandingOrgId: "o1" })).toBe(
      "/dashboard/organization/o1",
    );
    expect(
      resolveDashboardLanding(user, { workspaceLandingOrgId: "gone" }),
    ).toBe("/dashboard/org-workspace/ow-1/home");
  });

  it("keeps the role home, and sends role=null to onboarding", () => {
    expect(
      resolveDashboardLanding({
        role: "CONSULTEE",
        consulteeProfileId: "ce-1",
        consultantProfileId: "cp-1",
      }),
    ).toBe("/dashboard/consultee/ce-1/home");
    expect(resolveDashboardLanding({ role: null })).toBe("/form/onboarding");
  });
});

describe("resolveGoHref", () => {
  const dual = {
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: "ce-1",
    organizationIds: ["o1"],
  };

  it("expert / client facets use the viewer's own profile ids", () => {
    expect(resolveGoHref("expert", ["earnings"], dual)).toBe(
      "/dashboard/consultant/cp-1/earnings",
    );
    expect(resolveGoHref("client", ["payments"], dual)).toBe(
      "/dashboard/consultee/ce-1/payments",
    );
    expect(resolveGoHref("client", [], { role: "CONSULTANT" })).toBe(
      "/dashboard",
    );
  });

  it("auto resolves an appointment by the viewer's side of it", () => {
    const path = ["appointments", "a1"];
    const side = (asConsultant: boolean, asConsultee: boolean) => ({
      asConsultant,
      asConsultee,
      organizationId: "o1",
    });
    expect(resolveGoHref("auto", path, dual, side(false, true))).toBe(
      "/dashboard/consultee/ce-1/appointments/a1",
    );
    expect(resolveGoHref("auto", path, dual, side(true, false))).toBe(
      "/dashboard/consultant/cp-1/appointments/a1",
    );
    expect(
      resolveGoHref(
        "auto",
        path,
        { role: "CONSULTEE", organizationIds: ["o1"] },
        side(false, false),
      ),
    ).toBe("/dashboard/organization/o1/appointments/a1");
  });

  it("auto falls back role-first, respects one-sided surfaces, rejects unsafe paths", () => {
    expect(resolveGoHref("auto", ["appointments"], dual)).toBe(
      "/dashboard/consultant/cp-1/appointments",
    );
    expect(
      resolveGoHref("auto", ["payments"], { ...dual, role: "CONSULTANT" }),
    ).toBe("/dashboard/consultee/ce-1/payments");
    expect(resolveGoHref("auto", ["..", "admin"], dual)).toBe("/dashboard");
    expect(resolveGoHref("nope", [], dual)).toBe("/dashboard");
  });
});
