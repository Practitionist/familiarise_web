/**
 * Every sidebar item must point at a route that actually has a page.
 *
 * This exists because the IA consolidation broke exactly that invariant: the
 * org settings route was renamed `page.tsx` → `GeneralPanel.tsx` to become a
 * tab, and the replacement `page.tsx` was never created. The sidebar kept
 * rendering "Settings", and every org role got a 404 on click. Nothing caught
 * it — tsc is happy (no import is missing), the tests were happy (nothing
 * imported the page), and the nav array still contained a plausible path.
 *
 * A filesystem check is the only thing that catches this class of bug, so it
 * lives here rather than being left to a manual click-through.
 */

import { existsSync } from "fs";
import { join } from "path";

import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";

const APP = join(process.cwd(), "app/dashboard");

/** A route resolves if any of its candidate segment layouts has a page.tsx. */
function resolves(...candidates: string[]): boolean {
  return candidates.some((c) => existsSync(join(APP, c, "page.tsx")));
}

describe("back-office nav targets resolve", () => {
  it.each(["admin", "staff"] as const)("%s tree", (tree) => {
    const paths = buildBackofficeNav(tree, { showTds: true }).flatMap((g) =>
      g.items.map((i) => i.path),
    );
    expect(paths.length).toBeGreaterThan(0);

    const missing = paths.filter(
      (p) =>
        !resolves(
          tree === "admin" ? `admin/${p}` : `staff/[staffId]/(features)/${p}`,
          // A couple of staff routes sit outside the (features) group.
          tree === "staff" ? `staff/[staffId]/${p}` : `admin/${p}`,
        ),
    );
    expect(missing).toEqual([]);
  });
});

/**
 * The org sidebar is built inside a client component from live query data, so
 * it can't be imported here. Assert against the full set of paths that file
 * declares — a literal list kept in step with the layout, which is still
 * enough to catch a page that stops existing.
 */
describe("org nav targets resolve", () => {
  const ORG_PATHS = [
    "home",
    "my-program",
    "compensation",
    "appointments",
    "members",
    "collaborations",
    "contracts",
    "purchase-orders",
    "programs",
    "billing",
    "payouts",
    "reimbursements",
    "disputes",
    "resources",
    "analytics",
    "audit",
    "consent",
    "settings",
  ];

  it.each(ORG_PATHS)("/%s has a page", (p) => {
    expect(resolves(`organization/[orgId]/${p}`)).toBe(true);
  });

  it("covers every path the layout actually declares", () => {
    // Guards the list above against drift: if someone adds a nav item and
    // forgets to add it here, this fails rather than silently under-testing.
    const layout = require("fs").readFileSync(
      join(APP, "organization/[orgId]/layout.tsx"),
      "utf8",
    ) as string;
    // Loose on purpose: items are written both multi-line and inline
    // (`{ name: "Overview", icon: Home, path: "home" }`), and MOBILE_TABS
    // repeats a subset — dedupe handles the overlap.
    const declared = Array.from(
      layout.matchAll(/path: "([a-z0-9-]+)"/g),
      (m) => m[1],
    );

    expect(Array.from(new Set(declared)).sort()).toEqual(
      Array.from(ORG_PATHS).sort(),
    );
  });
});

describe("personal + workspace nav targets resolve", () => {
  const TREES: Array<[string, string, string]> = [
    [
      "consultant",
      "consultant/[consultantId]/layout.tsx",
      "consultant/[consultantId]/(features)",
    ],
    [
      "consultee",
      "consultee/[consulteeId]/layout.tsx",
      "consultee/[consulteeId]/(features)",
    ],
    [
      "org-workspace",
      "org-workspace/[orgWorkspaceId]/OrgWorkspaceShell.tsx",
      "org-workspace/[orgWorkspaceId]",
    ],
  ];

  it.each(TREES)("%s", (_name, layoutRel, routeBase) => {
    const src = require("fs").readFileSync(join(APP, layoutRel), "utf8") as string;
    const paths = Array.from(
      new Set(Array.from(src.matchAll(/path: "([a-z0-9-]+)"/g), (m) => m[1])),
    );
    expect(paths.length).toBeGreaterThan(0);

    const missing = paths.filter((p) => !resolves(`${routeBase}/${p}`));
    expect(missing).toEqual([]);
  });
});
