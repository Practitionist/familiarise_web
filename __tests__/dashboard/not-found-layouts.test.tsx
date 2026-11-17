/**
 * A loading.tsx at or above a dashboard page streams a 200 before notFound() runs.
 * Each role-root layout therefore checks the id itself, and no ancestor of a
 * checking layout may carry a loading.tsx.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const mockRequireOnboarded = jest.fn();
const mockConsultantProfile = jest.fn();
const mockConsulteeProfile = jest.fn();
const mockOrgDetails = jest.fn();
const mockWorkspaceCount = jest.fn();

jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T,>(fn: T) => fn,
}));
jest.mock("next/navigation", () => ({ notFound: () => mockNotFound() }));
// The viewer-zone wrapper reads the session; these layouts are tested for their 404 alone.
jest.mock("@/app/support/_components/ViewerZone", () => ({
  ViewerZone: ({ children }: { children: unknown }) => children,
}));
jest.mock("@/lib/auth-guard", () => ({
  requireOnboarded: () => mockRequireOnboarded(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findUnique: (args: unknown) => mockConsultantProfile(args),
    },
    consulteeProfile: {
      findUnique: (args: unknown) => mockConsulteeProfile(args),
    },
    membership: { count: () => mockWorkspaceCount() },
  },
}));
jest.mock("@/lib/data/org-details-server", () => ({
  getOrgDetailsForSeed: (id: string) => mockOrgDetails(id),
}));
jest.mock("@/lib/dashboard/account-href", () => ({
  accountSettingsHref: () => "/account",
}));
jest.mock(
  "@/app/dashboard/consultant/[consultantId]/ConsultantDashboardLayout",
  () => ({ __esModule: true, default: () => null }),
);
jest.mock(
  "@/app/dashboard/consultee/[consulteeId]/ConsulteeDashboardLayout",
  () => ({ __esModule: true, default: () => null }),
);
jest.mock("@/app/dashboard/organization/[orgId]/OrgDashboardShell", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock(
  "@/app/dashboard/org-workspace/[orgWorkspaceId]/OrgWorkspaceShell",
  () => ({ OrgWorkspaceShell: () => null }),
);

type LayoutProps = {
  children: string;
  params: Promise<Record<string, string>>;
};

async function load(dir: string) {
  const mod = await import(`@/${dir}/layout`);
  return mod.default as (props: LayoutProps) => Promise<unknown>;
}

const OWNER = { id: "u1", role: "CONSULTEE", orgWorkspaceProfileId: "w1" };

const SEGMENTS = [
  {
    dir: "app/dashboard/consultant/[consultantId]",
    param: "consultantId",
    arrange: () => {
      mockRequireOnboarded.mockResolvedValue({
        user: { ...OWNER, role: "CONSULTANT", consultantProfileId: "real" },
      });
    },
    arrangeForeign: () => {
      mockRequireOnboarded.mockResolvedValue({
        user: { ...OWNER, consultantProfileId: "mine" },
      });
    },
  },
  {
    dir: "app/dashboard/consultee/[consulteeId]",
    param: "consulteeId",
    arrange: () => {
      mockRequireOnboarded.mockResolvedValue({
        user: { ...OWNER, consulteeProfileId: "real" },
      });
    },
    arrangeForeign: () => {
      mockRequireOnboarded.mockResolvedValue({
        user: { ...OWNER, consulteeProfileId: "mine" },
      });
    },
  },
  {
    dir: "app/dashboard/organization/[orgId]",
    param: "orgId",
    arrange: (found: boolean) => {
      mockOrgDetails.mockResolvedValue(found ? { id: "o" } : null);
    },
    arrangeForeign: () => mockOrgDetails.mockResolvedValue(null),
  },
  {
    dir: "app/dashboard/org-workspace/[orgWorkspaceId]",
    param: "orgWorkspaceId",
    arrange: (found: boolean) => {
      mockRequireOnboarded.mockResolvedValue({ user: OWNER });
      mockWorkspaceCount.mockResolvedValue(1);
      return found;
    },
    arrangeForeign: () =>
      mockRequireOnboarded.mockResolvedValue({
        user: { ...OWNER, orgWorkspaceProfileId: "other" },
      }),
    foundId: "w1",
  },
];

const idFor = (s: (typeof SEGMENTS)[number], found: boolean) =>
  found ? ("foundId" in s && s.foundId) || "real" : "nope";

describe("dashboard role roots 404 from their layout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(SEGMENTS)("$dir calls notFound() for a missing id", async (s) => {
    s.arrange(false);
    if (s.param === "orgWorkspaceId") s.arrangeForeign();
    const Layout = await load(s.dir);
    await expect(
      Layout({
        children: "kids",
        params: Promise.resolve({ [s.param]: idFor(s, false) }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it.each(SEGMENTS)(
    "$dir calls notFound() for an id the viewer does not own",
    async (s) => {
      s.arrangeForeign();
      const Layout = await load(s.dir);
      await expect(
        Layout({
          children: "kids",
          params: Promise.resolve({ [s.param]: idFor(s, false) }),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
    },
  );

  it.each(SEGMENTS)("$dir renders for a valid id", async (s) => {
    s.arrange(true);
    const Layout = await load(s.dir);
    await expect(
      Layout({
        children: "kids",
        params: Promise.resolve({ [s.param]: idFor(s, true) }),
      }),
    ).resolves.toBeTruthy();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("lets an operator open an existing profile they do not own", async () => {
    mockRequireOnboarded.mockResolvedValue({
      user: { id: "admin", role: "ADMIN" },
    });
    mockConsultantProfile.mockResolvedValue({ id: "c1" });
    const Layout = await load("app/dashboard/consultant/[consultantId]");
    await expect(
      Layout({
        children: "kids",
        params: Promise.resolve({ consultantId: "c1" }),
      }),
    ).resolves.toBeTruthy();
  });

  it("still 404s an operator for a missing profile", async () => {
    mockRequireOnboarded.mockResolvedValue({
      user: { id: "admin", role: "STAFF" },
    });
    mockConsulteeProfile.mockResolvedValue(null);
    const Layout = await load("app/dashboard/consultee/[consulteeId]");
    await expect(
      Layout({
        children: "kids",
        params: Promise.resolve({ consulteeId: "nope" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["app/dashboard/consultant/[consultantId]", "consultantId"],
    ["app/dashboard/consultee/[consulteeId]", "consulteeId"],
  ])("%s answers an owner from the session alone", async (dir, param) => {
    mockRequireOnboarded.mockResolvedValue({
      user: { ...OWNER, consultantProfileId: "c1", consulteeProfileId: "e1" },
    });
    const Layout = await load(dir);
    await expect(
      Layout({
        children: "kids",
        params: Promise.resolve({
          [param]: param === "consultantId" ? "c1" : "e1",
        }),
      }),
    ).resolves.toBeTruthy();
    expect(mockConsultantProfile).not.toHaveBeenCalled();
    expect(mockConsulteeProfile).not.toHaveBeenCalled();
  });
});

describe("no loading.tsx sits above a checking dashboard layout", () => {
  const CHECKED = [
    ...SEGMENTS.map((s) => s.dir),
    "app/dashboard/(backoffice)/[tree]",
  ];

  it("keeps a dashboard not-found boundary and no root loading", () => {
    expect(existsSync(path.join(process.cwd(), "app/loading.tsx"))).toBe(false);
    expect(
      existsSync(path.join(process.cwd(), "app/dashboard/not-found.tsx")),
    ).toBe(true);
  });

  it.each(CHECKED)(
    "%s is a server layout with no ancestor loading.tsx",
    (dir) => {
      const layout = readFileSync(
        path.join(process.cwd(), dir, "layout.tsx"),
        "utf8",
      );
      expect(layout).not.toMatch(/^"use client"/);
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
