/**
 * @jest-environment node
 */

/**
 * The org consent surface returns only this org's (and the platform's)
 * fiduciary rows for current members: another org's `org:<id>` artifacts
 * would reveal the member's membership and consent history there.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { NextRequest } from "next/server";

const mockFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    orgAuditLog: { findMany: async () => [] },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    session: { user: { id: "user-op" } },
    member: { id: "member-op", role: "OWNER" },
    org: { id: "org-A" },
  })),
}));

import { GET } from "@/app/api/organizations/[orgId]/consent/route";

describe("GET /api/organizations/[orgId]/consent", () => {
  beforeEach(() => mockFindMany.mockResolvedValue([]));

  it.each([["?userId=user-x"], [""]])(
    "scopes an operator read (%s) to this org's fiduciary and current members",
    async (qs) => {
      const res = await GET(
        new NextRequest(
          `https://app.test/api/organizations/org-A/consent${qs}`,
        ),
        { params: Promise.resolve({ orgId: "org-A" }) },
      );
      expect(res.status).toBe(200);
      const args = mockFindMany.mock.calls[0][0];
      expect(args.where.dataFiduciary).toEqual({
        in: ["org:org-A", "Familiarise"],
      });
      expect(args.where.user.memberships.some).toEqual({
        organizationId: "org-A",
        status: { in: ["ACTIVE", "SUSPENDED"] },
      });
      expect(args.select).toBeDefined();
      expect(args.select.subjectPseudonymousId).toBeUndefined();
    },
  );
});

describe("every org-route consentArtifact read names a fiduciary", () => {
  function routes(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return routes(path);
      return name === "route.ts" ? [path] : [];
    });
  }

  it("app/api/organizations/** has no consentArtifact.find* without dataFiduciary", () => {
    const root = join(process.cwd(), "app/api/organizations");
    const offenders: string[] = [];
    for (const path of routes(root)) {
      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(
        /consentArtifact\.find\w*\(\{[\s\S]*?\n\s{2}\}\);/g,
      )) {
        if (!m[0].includes("dataFiduciary")) {
          offenders.push(relative(root, path));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
