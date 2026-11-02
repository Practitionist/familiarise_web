/**
 * A loading.tsx at or above a dynamic page streams a 200 before notFound() runs.
 * Each public dynamic segment therefore checks existence in its own layout, which
 * sits above its own loading.tsx, and no ancestor may carry a loading.tsx.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const mockReader = jest.fn();

jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
const mockSession = jest.fn();
const mockMembership = jest.fn();

jest.mock("@/lib/auth-server", () => ({
  getSession: () => mockSession(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findFirst: (args: unknown) => mockMembership(args) },
  },
}));
jest.mock("@/lib/data/plan-details", () => ({
  getClassPlanDetail: (id: string) => mockReader(id),
  getWebinarPlanDetail: (id: string) => mockReader(id),
  getSubscriptionPlanDetail: (id: string) => mockReader(id),
  getConsultationPlanDetail: (id: string) => mockReader(id),
}));
jest.mock("@/lib/data/recordings-explore", () => ({
  getPublicRecordingBySlug: (id: string) => mockReader(id),
}));
jest.mock("@/lib/data/consultant-detail", () => ({
  getConsultantDetail: (id: string) => mockReader(id),
}));
jest.mock("@/lib/data/digital-products-public", () => ({
  getDigitalProductForViewer: (id: string) => mockReader(id),
}));
jest.mock(
  "@/app/explore/enterprise/organisations/[orgSlug]/org-reader",
  () => ({ fetchOrgBySlug: (id: string) => mockReader(id) }),
);

const PUBLIC_PLAN = {
  id: "plan",
  visibility: "PUBLIC",
  organizationId: null,
  archivedAt: null,
  status: "PUBLISHED",
};

const SEGMENTS = [
  {
    dir: "app/explore/experts/[consultantId]",
    param: "consultantId",
    found: { user: {} },
  },
  { dir: "app/explore/products/[slug]", param: "slug", found: { id: "p" } },
  { dir: "app/explore/recordings/[slug]", param: "slug", found: { id: "r" } },
  {
    dir: "app/explore/enterprise/organisations/[orgSlug]",
    param: "orgSlug",
    found: { id: "o" },
  },
  {
    dir: "app/explore/programs/plans/classes/[classPlanId]",
    param: "classPlanId",
    found: PUBLIC_PLAN,
  },
  {
    dir: "app/explore/programs/plans/consultations/[consultationPlanId]",
    param: "consultationPlanId",
    found: PUBLIC_PLAN,
  },
  {
    dir: "app/explore/programs/plans/subscriptions/[subscriptionPlanId]",
    param: "subscriptionPlanId",
    found: PUBLIC_PLAN,
  },
  {
    dir: "app/explore/programs/plans/webinars/[webinarPlanId]",
    param: "webinarPlanId",
    found: PUBLIC_PLAN,
  },
];

async function load(dir: string) {
  const mod = await import(`@/${dir}/layout`);
  return mod.default as (props: {
    children: string;
    params: Promise<Record<string, string>>;
  }) => Promise<unknown>;
}

describe("public dynamic segments 404 from their layout", () => {
  beforeEach(() => {
    mockNotFound.mockClear();
    mockReader.mockReset();
    mockSession.mockReset();
    mockSession.mockResolvedValue({ user: { id: "u1" } });
    mockMembership.mockReset();
    mockMembership.mockResolvedValue(null);
  });

  it.each(SEGMENTS)(
    "$dir calls notFound() for a missing item",
    async ({ dir, param }) => {
      mockReader.mockResolvedValue(null);
      const Layout = await load(dir);
      await expect(
        Layout({
          children: "kids",
          params: Promise.resolve({ [param]: "nope" }),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mockNotFound).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SEGMENTS)(
    "$dir renders children for a found item",
    async ({ dir, param, found }) => {
      mockReader.mockResolvedValue(found);
      const Layout = await load(dir);
      await expect(
        Layout({
          children: "kids",
          params: Promise.resolve({ [param]: "real" }),
        }),
      ).resolves.toBe("kids");
      expect(mockNotFound).not.toHaveBeenCalled();
    },
  );
});

describe("plan layouts gate visibility, not just existence", () => {
  const PLAN_DIR = "app/explore/programs/plans/classes/[classPlanId]";
  const run = async () => {
    const Layout = await load(PLAN_DIR);
    return Layout({
      children: "kids",
      params: Promise.resolve({ classPlanId: "p" }),
    });
  };

  it("404s an archived plan", async () => {
    mockReader.mockResolvedValue({ ...PUBLIC_PLAN, archivedAt: new Date() });
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s an ORG_ONLY plan for a non-member", async () => {
    mockReader.mockResolvedValue({
      ...PUBLIC_PLAN,
      visibility: "ORG_ONLY",
      organizationId: "org1",
    });
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders an ORG_ONLY plan for an active member", async () => {
    mockReader.mockResolvedValue({
      ...PUBLIC_PLAN,
      visibility: "ORG_ONLY",
      organizationId: "org1",
    });
    mockMembership.mockResolvedValue({ id: "m1" });
    await expect(run()).resolves.toBe("kids");
  });
});

describe("no loading.tsx sits above a public dynamic page", () => {
  it("has no root loading.tsx", () => {
    expect(existsSync(path.join(process.cwd(), "app/loading.tsx"))).toBe(false);
  });

  it.each(SEGMENTS)(
    "$dir has no loading.tsx in any ancestor segment",
    ({ dir }) => {
      const parts = dir.split("/");
      const offenders: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (existsSync(path.join(process.cwd(), ancestor, "loading.tsx"))) {
          offenders.push(ancestor);
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});
