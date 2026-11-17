/**
 * @jest-environment node
 */

/**
 * Every back-office route asks the permission matrix: the two raw role guards
 * are gone from `lib/auth-helpers.ts`, and so are the dead routes they served.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// Built from parts so this file is not itself a match.
const RAW_GUARD = new RegExp(
  `require(${["Admin", "Privileged"].join("|")})Auth`,
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

it("lib/auth-helpers.ts defines no raw role guard", () => {
  const src = readFileSync(join(ROOT, "lib/auth-helpers.ts"), "utf8");
  expect(src).not.toMatch(RAW_GUARD);
  expect(src).toContain("export async function requireBackofficeSurface");
  expect(src).toContain("export function isPrivileged");
});

it.each(["app", "lib", "components"])("no file under %s/ names one", (dir) => {
  const hits = sourceFiles(join(ROOT, dir)).filter((file) =>
    RAW_GUARD.test(readFileSync(file, "utf8")),
  );
  expect(hits).toEqual([]);
});

it.each([
  "app/api/admin/users/[userId]/route.ts",
  "app/api/staff/stats/route.ts",
  "lib/data/staff-stats.ts",
  "components/dashboard/shared/support/AppointmentContextCard.tsx",
])("the dead %s is deleted", (file) => {
  expect(existsSync(join(ROOT, file))).toBe(false);
});
