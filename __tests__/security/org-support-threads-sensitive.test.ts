/** @jest-environment node */

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: jest.fn(async () => ({ member: { role: "OWNER" } })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { ORG_SENSITIVE_PERSONAL_CATEGORIES } from "../../lib/support/case-access";
import { GET } from "../../app/api/organizations/[orgId]/support-threads/route";

const db = prisma as unknown as {
  supportCase: { findMany: jest.Mock; count: jest.Mock };
};

const call = (query = "") =>
  GET(
    new NextRequest(
      `https://test/api/organizations/org-1/support-threads${query}`,
    ),
    {
      params: Promise.resolve({ orgId: "org-1" }),
    },
  );

describe("org support triage withholds members' complaints about the org", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists no PERSONAL case in a sensitive category and keeps uncategorised ones", async () => {
    await call();
    const { where } = db.supportCase.findMany.mock.calls[0][0];
    expect(where.AND[1]).toEqual({
      OR: [
        { ownershipScope: { not: "PERSONAL" } },
        { category: null },
        { category: { notIn: [...ORG_SENSITIVE_PERSONAL_CATEGORIES] } },
      ],
    });
    expect(ORG_SENSITIVE_PERSONAL_CATEGORIES).toEqual(
      expect.arrayContaining(["ORG_ADMIN_DISPUTE", "QUALITY_COMPLAINT"]),
    );
  });

  it("reports withheld complaints as a count with no member identity", async () => {
    db.supportCase.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    const response = await call("?status=OPEN");
    const body = await response.json();

    expect(body.withheld).toEqual({ sensitivePersonal: 2 });
    const withheldWhere = db.supportCase.count.mock.calls[1][0].where;
    expect(withheldWhere.AND[0]).toMatchObject({
      organizationId: "org-1",
      status: "OPEN",
    });
    expect(withheldWhere.AND[1]).toEqual({
      ownershipScope: "PERSONAL",
      category: { in: [...ORG_SENSITIVE_PERSONAL_CATEGORIES] },
    });
    expect(JSON.stringify(body)).not.toContain("member");
  });
});
