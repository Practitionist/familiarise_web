/**
 * @jest-environment node
 */

/**
 * Planner group: every consultantProfile relation the planner reads is an
 * explicit select, never a bare include or `true`.
 */

import {
  allKeys,
  consultantProfileValues,
  isBare,
  readSource as read,
} from "../fixtures/consultant-projection";
import { GET } from "../../app/api/dashboard/consultant/[consultantId]/planner/route";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { PROFILE_OWNER_SELECT } from "@/lib/booking/list-selects";
import { CONSULTANT_PII_FIELDS } from "@/lib/data/consultant-public";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: () => false,
  forbiddenResponse: jest.fn(),
}));
jest.mock("../../lib/api/scope/parse", () => ({
  __esModule: true,
  resolveOrgScope: () => ({ ok: true, scope: { kind: "all" } }),
  scopeOrgId: () => null,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: { findMany: jest.fn() },
    class: { findMany: jest.fn() },
    collaborator: { findMany: jest.fn() },
    consultantProfile: { findUnique: jest.fn() },
    membership: { findMany: jest.fn() },
    appointmentOccurrence: { groupBy: jest.fn() },
  },
}));

const db = prisma as unknown as {
  webinar: { findMany: jest.Mock };
  class: { findMany: jest.Mock };
  collaborator: { findMany: jest.Mock };
  consultantProfile: { findUnique: jest.Mock };
  membership: { findMany: jest.Mock };
};
const mockedAuth = requireApiAuth as unknown as jest.Mock;

describe("planner GET projects consultantProfile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({
      session: {
        user: { id: "u-1", role: "CONSULTANT", consultantProfileId: "cp-1" },
      },
    });
    db.consultantProfile.findUnique.mockResolvedValue({ userId: "u-1" });
    db.membership.findMany.mockResolvedValue([]);
    db.collaborator.findMany.mockResolvedValue([]);
    db.webinar.findMany.mockResolvedValue([]);
    db.class.findMany.mockResolvedValue([]);
  });

  it("hands the owner select to every webinar and class query", async () => {
    const res = await GET(new Request("http://localhost/api/x"), {
      params: Promise.resolve({ consultantId: "cp-1" }),
    });
    expect(res.status).toBe(200);

    const webinarCalls = db.webinar.findMany.mock.calls;
    const classCalls = db.class.findMany.mock.calls;
    expect(webinarCalls).toHaveLength(2);
    expect(classCalls).toHaveLength(2);
    for (const [args] of webinarCalls) {
      expect(args.include.webinarPlan.include.consultantProfile).toEqual(
        PROFILE_OWNER_SELECT,
      );
    }
    for (const [args] of classCalls) {
      expect(args.include.classPlan.include.consultantProfile).toEqual(
        PROFILE_OWNER_SELECT,
      );
    }
  });

  it("never passes a bare or included consultantProfile to Prisma", async () => {
    await GET(new Request("http://localhost/api/x"), {
      params: Promise.resolve({ consultantId: "cp-1" }),
    });
    const calls = [
      ...db.webinar.findMany.mock.calls,
      ...db.class.findMany.mock.calls,
      ...db.consultantProfile.findUnique.mock.calls,
    ];
    const values = consultantProfileValues(calls);
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter(isBare)).toEqual([]);
  });

  it("returns only the planner payload keys", async () => {
    db.webinar.findMany.mockResolvedValueOnce([
      {
        id: "w-1",
        webinarPlanId: "wp-1",
        webinarPlan: {
          id: "wp-1",
          consultantProfile: { id: "cp-1", userId: "u-1" },
          topics: [],
        },
        appointment: null,
      },
    ]);
    const res = await GET(new Request("http://localhost/api/x"), {
      params: Promise.resolve({ consultantId: "cp-1" }),
    });
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["data", "success"]);
    expect(Object.keys(body.data).sort()).toEqual([
      "classes",
      "participantCounts",
      "webinars",
    ]);
    expect(body.data.webinars[0].webinarPlan.consultantProfile).toEqual({
      id: "cp-1",
      userId: "u-1",
    });
  });
});

describe("planner sources use explicit consultantProfile projections", () => {
  const files = [
    "app/api/dashboard/consultant/[consultantId]/planner/route.ts",
    "lib/data/consultant-dashboard.ts",
  ];

  it.each(files)("%s has no bare consultantProfile fetch", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/consultantProfile:\s*true/);
    expect(src).not.toMatch(/consultantProfile:\s*\{\s*include/);
    expect(src).not.toMatch(/consultantProfile:\s*\{[^}]*user:\s*true/);
  });

  it("the planner route references PROFILE_OWNER_SELECT for both plan kinds", () => {
    const src = read(
      "app/api/dashboard/consultant/[consultantId]/planner/route.ts",
    );
    expect(
      src.match(/consultantProfile:\s*PROFILE_OWNER_SELECT/g),
    ).toHaveLength(2);
  });

  it("planOwnerSelect exposes the plan owner without an email", () => {
    const src = read("lib/data/consultant-dashboard.ts");
    const start = src.indexOf("const planOwnerSelect = {");
    const block = src.slice(start, src.indexOf("} as const;", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(
      /user:\s*\{\s*select:\s*\{\s*id: true, name: true, image: true\s*\}\s*\}/,
    );
    expect(block).not.toMatch(/\bemail\b/);
  });

  it("PROFILE_OWNER_SELECT carries no statutory PII column", () => {
    const keys = allKeys(PROFILE_OWNER_SELECT);
    const leaked = CONSULTANT_PII_FIELDS.filter((f) => keys.includes(f));
    expect(leaked).toEqual([]);
  });
});
