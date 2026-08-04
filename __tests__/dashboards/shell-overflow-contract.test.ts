/**
 * Dashboard shells must clip document scroll and keep overflow inside <main>.
 * Without overflow-hidden + min-h-0 on the flex chain, tall pages expand the
 * document past the shell into empty body white space.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const SHELL_SOURCES = [
  "components/dashboard/PersonalDashboardShell.tsx",
  "components/dashboard/OperatorDashboardShell.tsx",
  "app/dashboard/organization/[orgId]/layout.tsx",
  "app/dashboard/org-workspace/[orgWorkspaceId]/OrgWorkspaceShell.tsx",
  "app/dashboard/organization/(switcher)/layout.tsx",
] as const;

describe("dashboard shell overflow contract", () => {
  it.each(SHELL_SOURCES)(
    "%s locks the viewport and scrolls inside main",
    (rel) => {
      const src = read(rel);
      expect(src).toContain("h-screen-maintenance");
      expect(src).toContain("overflow-hidden");
      expect(src).toContain("min-h-0");
      expect(src).toMatch(/main[^>]*min-h-0[^>]*overflow-y-auto|main[^>]*overflow-y-auto[^>]*min-h-0/);
    },
  );

  it(".h-screen-maintenance uses 100dvh", () => {
    const css = read("app/globals.css");
    const block = css.slice(
      css.indexOf(".h-screen-maintenance"),
      css.indexOf(".h-screen-maintenance") + 160,
    );
    expect(block).toContain("100dvh");
    expect(block).not.toContain("100vh");
  });

  it("dashboard layout mounts a document scroll lock", () => {
    const layout = read("app/dashboard/layout.tsx");
    const lock = read("components/dashboard/DashboardScrollLock.tsx");
    const css = read("app/globals.css");
    expect(layout).toContain("DashboardScrollLock");
    expect(lock).toContain("dashboard-scroll-locked");
    expect(css).toContain("html.dashboard-scroll-locked");
    expect(css).toContain("overflow: hidden");
  });

  it("HelpSkeleton does not nest min-h-screen inside the shell", () => {
    const src = read("components/dashboard/DashboardSkeletons.tsx");
    const start = src.indexOf("export function HelpSkeleton");
    const block = src.slice(start, start + 400);
    expect(block).not.toContain("min-h-screen");
  });

  it("ProfileSection does not stretch the summary column with h-full / % height", () => {
    const src = read(
      "app/dashboard/consultant/[consultantId]/(features)/settings/sections/ProfileSection.tsx",
    );
    expect(src).not.toContain('h-full"');
    expect(src).not.toContain("h-[calc(100%-6rem)]");
    expect(src).toContain("min-h-[16rem]");
  });
});
