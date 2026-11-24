/** @jest-environment node */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const mockListIndexablePlans = jest.fn();
jest.mock("@/lib/data/indexable-plans", () => ({
  listIndexableEventPlanIds: (...args: unknown[]) =>
    mockListIndexablePlans(...args),
}));
const mockListIndexableExperts = jest.fn();
const mockListIndexableDomains = jest.fn();
jest.mock("@/lib/data/indexable-experts", () => ({
  listIndexableExpertIds: (...args: unknown[]) =>
    mockListIndexableExperts(...args),
  listIndexableDomainNames: (...args: unknown[]) =>
    mockListIndexableDomains(...args),
}));
const mockListProductTopics = jest.fn();
jest.mock("@/lib/data/digital-products-public", () => ({
  listProductTopics: (...args: unknown[]) => mockListProductTopics(...args),
}));
const mockReportSentryError = jest.fn();
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));

import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { metadata as blogMetadata } from "@/app/blog/layout";

let entries: Awaited<ReturnType<typeof sitemap>>;
beforeAll(async () => {
  mockListProductTopics.mockResolvedValue([
    { id: "d1", name: "Technology", count: 3 },
    { id: "d2", name: "Creative Arts", count: 1 },
  ]);
  mockListIndexableExperts.mockResolvedValue(["c-1", "c-2"]);
  mockListIndexableDomains.mockResolvedValue(["Technology", "Creative Arts"]);
  mockListIndexablePlans.mockResolvedValue({
    webinarPlanIds: ["wp-1", "wp-2"],
    classPlanIds: ["cp-1"],
  });
  entries = await sitemap();
});
const pathnameOf = (url: string) => new URL(url).pathname;

const segmentsOf = (pathname: string) =>
  pathname.split("/").filter((segment) => segment.length > 0);

function collectPageFiles(dir: string): string[] {
  const pages: string[] = [];
  for (const name of readdirSync(dir)) {
    const absolute = path.join(dir, name);
    if (statSync(absolute).isDirectory()) {
      pages.push(...collectPageFiles(absolute));
    } else if (name === "page.tsx") {
      pages.push(absolute);
    }
  }
  return pages;
}

function routePatternFor(pageFile: string): string[] {
  const appDir = path.join(process.cwd(), "app");
  const relativeDir = path.relative(appDir, path.dirname(pageFile));
  if (relativeDir === "") return [];

  return relativeDir
    .split(path.sep)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .map((segment) => (/^\[[^\]]+\]$/.test(segment) ? "*" : segment));
}

function patternMatches(segments: string[], pattern: string[]): boolean {
  if (segments.length !== pattern.length) return false;
  return pattern.every(
    (part, index) => part === "*" || part === segments[index],
  );
}

describe("sitemap", () => {
  it("returns absolute, unique entries with priority and changeFrequency", () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(typeof entry.priority).toBe("number");
      expect(typeof entry.changeFrequency).toBe("string");
      expect(entry.lastModified).toBeUndefined();
    }

    const urls = entries.map((entry) => entry.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("lists the webinar and class plans on sale, each once", () => {
    const pathnames = entries.map((entry) => pathnameOf(entry.url));
    expect(
      pathnames.filter((p) => p.startsWith("/explore/programs/plans/")),
    ).toEqual([
      "/explore/programs/plans/webinars/wp-1",
      "/explore/programs/plans/webinars/wp-2",
      "/explore/programs/plans/classes/cp-1",
    ]);
  });

  it("lists each verified expert profile once", () => {
    const pathnames = entries.map((entry) => pathnameOf(entry.url));
    expect(
      pathnames.filter((p) => /^\/explore\/experts\/[^/]+$/.test(p)),
    ).toEqual(["/explore/experts/c-1", "/explore/experts/c-2"]);
  });

  it("lists a category page per field that has experts", () => {
    const pathnames = entries.map((entry) => pathnameOf(entry.url));
    expect(pathnames).toEqual(
      expect.arrayContaining([
        "/explore/experts/c/technology",
        "/explore/experts/c/creative-arts",
      ]),
    );
  });

  it("lists a products page per field that has products on sale", () => {
    const pathnames = entries.map((entry) => pathnameOf(entry.url));
    expect(pathnames).toEqual(
      expect.arrayContaining([
        "/explore/products/c/technology",
        "/explore/products/c/creative-arts",
      ]),
    );
  });

  it("keeps the static routes and reports once when the expert query fails", async () => {
    mockReportSentryError.mockClear();
    mockListIndexableExperts.mockRejectedValueOnce(new Error("db down"));
    const degraded = await sitemap();
    const pathnames = degraded.map((entry) => pathnameOf(entry.url));
    expect(pathnames).toContain("/explore/experts");
    expect(pathnames).not.toContain("/explore/experts/c-1");
    expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  });

  it("keeps the static routes and reports once when the plan query fails", async () => {
    mockReportSentryError.mockClear();
    mockListIndexablePlans.mockRejectedValueOnce(new Error("db down"));
    const degraded = await sitemap();
    const pathnames = degraded.map((entry) => pathnameOf(entry.url));
    expect(pathnames).toContain("/explore/programs");
    expect(
      pathnames.some((p) => p.startsWith("/explore/programs/plans/")),
    ).toBe(false);
    expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  });

  it("includes every public marketing and help route", () => {
    const pathnames = new Set(entries.map((entry) => pathnameOf(entry.url)));
    const required = [
      "/",
      "/explore/experts",
      "/explore/programs",
      "/explore/enterprise/organisations",
      "/explore/products",
      "/become-an-expert",
      "/enterprise",
      "/enterprise/team-training",
      "/enterprise/corporate-mentorship",
      "/enterprise/demo",
      "/enterprise/funding",
      "/enterprise/institutions",
      "/enterprise/security",
      "/use-cases/mentorship",
      "/use-cases/early-career",
      "/use-cases/college-students",
      "/use-cases/career-switchers",
      "/about",
      "/pricing",
      "/contactus",
      "/support",
      "/terms",
      "/privacy",
      "/refund",
      "/reviews-policy",
      "/grievance",
    ];

    expect(required.filter((route) => !pathnames.has(route))).toEqual([]);
  });

  it("omits private, authenticated, and placeholder routes", () => {
    const blocked = [
      "/blog",
      "/api",
      "/dashboard",
      "/checkout",
      "/auth",
      "/settings",
      "/meetings",
      "/files",
      "/organizations/invite",
      "/onboarding",
      "/form",
    ];

    const leaked = entries
      .map((entry) => pathnameOf(entry.url))
      .filter((pathname) =>
        blocked.some(
          (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        ),
      );

    expect(leaked).toEqual([]);
  });

  it("does not stamp entries with build-time timestamps", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app", "sitemap.ts"),
      "utf8",
    );

    expect(source).not.toContain("lastModified: new Date()");
  });

  it("resolves every sitemap path to an app page.tsx", () => {
    const appDir = path.join(process.cwd(), "app");
    const patterns = collectPageFiles(appDir).map(routePatternFor);

    const unresolved = entries
      .map((entry) => segmentsOf(pathnameOf(entry.url)))
      .filter(
        (segments) =>
          !patterns.some((pattern) => patternMatches(segments, pattern)),
      )
      .map((segments) => `/${segments.join("/")}`);

    expect(unresolved).toEqual([]);
  });
});

describe("robots", () => {
  it("disallows private surfaces and points at the sitemap origin", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;

    expect(rules.userAgent).toBe("*");

    const disallow =
      typeof rules.disallow === "string"
        ? [rules.disallow]
        : (rules.disallow ?? []);

    expect(disallow).toEqual([
      "/api/",
      "/dashboard",
      "/onboarding/",
      "/form/onboarding",
      "/auth/",
      "/checkout/",
      "/settings/",
      "/meetings/",
      "/files/",
      "/organizations/invite/",
    ]);
    expect(disallow).not.toContain("/");
    expect(disallow).not.toContain("/explore");

    const sitemapUrl = Array.isArray(result.sitemap)
      ? result.sitemap[0]
      : result.sitemap;

    expect(sitemapUrl).toMatch(/\/sitemap\.xml$/);
    if (typeof sitemapUrl !== "string") {
      throw new Error("robots() must declare a sitemap URL");
    }
    expect(new URL(sitemapUrl).origin).toBe(new URL(entries[0].url).origin);
  });
});

describe("placeholder pages and outbound links", () => {
  it("noindexes placeholder pages", () => {
    expect(blogMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("links fields through their category pages, never a name in a query string", () => {
    const read = (file: string) =>
      readFileSync(path.join(process.cwd(), file), "utf8");
    // The navbar chips and the landing field tiles link fields; the footer has none.
    for (const file of [
      "lib/navigation/public-nav.ts",
      "components/home/CategoriesSection.tsx",
    ]) {
      expect(read(file)).toContain("domainPath(");
    }
    for (const file of [
      "components/Footer.tsx",
      "lib/navigation/public-nav.ts",
      "components/home/CategoriesSection.tsx",
    ]) {
      expect(read(file)).not.toContain("?domain=");
    }
  });

  it("keeps internal navigation internal and off authoring-only docs paths", () => {
    const footer = readFileSync(
      path.join(process.cwd(), "components", "Footer.tsx"),
      "utf8",
    );
    expect(footer).toContain(
      '{ label: "Become an expert", href: "/become-an-expert" }',
    );
    expect(footer).not.toContain("external: true");
    expect(footer).not.toContain("ArrowUpRight");

    const exportsPanel = readFileSync(
      path.join(
        process.cwd(),
        "app",
        "dashboard",
        "organization",
        "[orgId]",
        "settings",
        "DataExportsPanel.tsx",
      ),
      "utf8",
    );
    expect(exportsPanel).toContain(
      'href="/support/getting-started/age-consent-delete-data"',
    );
    expect(exportsPanel).not.toContain("/docs/enterprise/");
  });
});
