/**
 * Every literal `goHref(facet, "<path>")` in the app must land on a real page
 * for each viewer shape the resolver can pick; old URLs answer 404, so a
 * deep link to a retired segment is a dead notification.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

import { resolveGoHref, type GoViewer } from "@/lib/dashboard/go";

const ROOT = process.cwd();
const APP = join(ROOT, "app");
const SCAN = ["app", "lib", "components", "emails"];
const GO_LITERAL = /goHref\(\s*"(expert|client|auto)",\s*"([^"]+)"\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Route-group dirs `(x)` are transparent; `[x]` dirs match any segment. */
function childDirs(dir: string): string[] {
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
}

function hasPage(dir: string, segments: readonly string[]): boolean {
  const groups = childDirs(dir).filter((n) => /^\(.+\)$/.test(n));
  if (groups.some((g) => hasPage(join(dir, g), segments))) return true;
  if (segments.length === 0) return existsSync(join(dir, "page.tsx"));
  const [head, ...rest] = segments;
  const dirs = childDirs(dir);
  if (dirs.includes(head) && hasPage(join(dir, head), rest)) return true;
  return dirs
    .filter((n) => /^\[[^.]+\]$/.test(n))
    .some((n) => hasPage(join(dir, n), rest));
}

const VIEWERS: Record<string, GoViewer> = {
  expertOnly: { role: "CONSULTANT", consultantProfileId: "c1" },
  clientOnly: { role: "CONSULTEE", consulteeProfileId: "e1" },
  dualExpert: {
    role: "CONSULTANT",
    consultantProfileId: "c1",
    consulteeProfileId: "e1",
  },
  dualClient: {
    role: "CONSULTEE",
    consultantProfileId: "c1",
    consulteeProfileId: "e1",
  },
  workspace: { role: "ORG_WORKSPACE", orgWorkspaceProfileId: "w1" },
};

const links = SCAN.flatMap((d) => sourceFiles(join(ROOT, d))).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(GO_LITERAL)].map((m) => ({
    file: relative(ROOT, file),
    facet: m[1],
    path: m[2],
  })),
);

describe("literal go deep links resolve to real pages", () => {
  it("finds the call sites", () => {
    expect(links.length).toBeGreaterThan(10);
  });

  it.each(Object.entries(VIEWERS))("for a %s viewer", (_name, viewer) => {
    const dead = links.flatMap(({ file, facet, path }) => {
      const href = resolveGoHref(facet, path.split("/"), viewer);
      if (href === "/dashboard") return [];
      const segments = href.replace(/^\//, "").split("/");
      return hasPage(APP, segments)
        ? []
        : [`${file}: ${facet}/${path} → ${href}`];
    });
    expect(dead).toEqual([]);
  });
});

describe("the email preferences link", () => {
  it.each([
    ["expertOnly", "/dashboard/consultant/c1/settings/notifications"],
    ["clientOnly", "/dashboard/consultee/e1/settings/notifications"],
    ["workspace", "/dashboard/org-workspace/w1/settings/notifications"],
  ])("opens a %s viewer's own Notifications settings", (name, expected) => {
    expect(
      resolveGoHref("auto", ["settings", "notifications"], VIEWERS[name]),
    ).toBe(expected);
  });
});
