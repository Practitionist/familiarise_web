/**
 * One-off route inventory generator for Enterprise Screens documentation.
 * Run: npx tsx scripts/generate-enterprise-screen-inventory.ts
 *
 * Outputs JSON to stdout — used to validate HTML docs cover all page.tsx routes.
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

const SCAN_ROOTS = [
  "app/auth",
  "app/form",
  "app/dashboard",
  "app/explore/enterprise",
  "app/organizations",
];

function findPageFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPageFiles(full));
    } else if (entry.name === "page.tsx") {
      results.push(full);
    }
  }
  return results;
}

interface ScreenEntry {
  file: string;
  route: string;
  segment: string;
  module: string;
}

function fileToRoute(filePath: string): string {
  let rel = filePath.replace(/^app\//, "").replace(/\/page\.tsx$/, "");
  // Remove route groups: (features), (switcher)
  rel = rel.replace(/\/\([^)]+\)/g, "");
  // Convert dynamic segments
  const parts = rel.split("/").map((p) => {
    if (p.startsWith("[") && p.endsWith("]")) {
      const param = p.slice(1, -1);
      return `:${param}`;
    }
    return p;
  });
  return "/" + parts.join("/");
}

function classifyModule(route: string): string {
  if (route.startsWith("/auth")) return "01-auth-and-onboarding";
  if (route.startsWith("/form/onboarding")) return "01-auth-and-onboarding";
  if (route.includes("/organization/create") || route.includes("/org-workspace") && route.includes("/create"))
    return "02-org-creation-wizard";
  if (route.startsWith("/dashboard/org-workspace")) return "03-org-workspace-dashboard";
  if (route.startsWith("/dashboard/organization")) return "04-organization-dashboard";
  if (route.startsWith("/dashboard/consultant")) return "05-consultant-dashboard";
  if (route.startsWith("/dashboard/consultee")) return "06-consultee-dashboard";
  if (route.startsWith("/dashboard/admin")) return "07-admin-dashboard";
  if (route.startsWith("/dashboard/staff")) return "08-staff-dashboard";
  if (route.startsWith("/explore/enterprise") || route.startsWith("/organizations/invite"))
    return "09-public-and-invite";
  if (route === "/dashboard" || route === "/dashboard/overage") return "10-flowcharts-and-guards";
  return "other";
}

function main() {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    for (const absFile of findPageFiles(abs)) {
      files.push(path.relative(ROOT, absFile));
    }
  }
  files.sort();

  const inventory: ScreenEntry[] = files.map((file) => {
    const route = fileToRoute(file);
    const segment = route.split("/").pop() ?? route;
    return {
      file,
      route,
      segment,
      module: classifyModule(route),
    };
  });

  const byModule: Record<string, ScreenEntry[]> = {};
  for (const entry of inventory) {
    if (!byModule[entry.module]) byModule[entry.module] = [];
    byModule[entry.module].push(entry);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    totalScreens: inventory.length,
    byModule: Object.fromEntries(
      Object.entries(byModule).map(([k, v]) => [k, { count: v.length, screens: v }])
    ),
    allScreens: inventory,
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
