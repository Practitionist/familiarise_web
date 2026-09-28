/**
 * Prints the org role × action matrix as Markdown, generated from
 * `lib/auth/org-permissions.ts`, the single source every org route and page
 * reads (#1851). Paste the output into the enterprise docs instead of
 * maintaining the table by hand, so the docs cannot drift from the code.
 *
 * Usage: npx tsx scripts/utils/print-org-role-matrix.ts > matrix.md
 *
 * Read-only: it imports one pure module and touches no database.
 */

import type { MemberRole } from "@prisma/client";

import { ORG_PERMISSIONS, type OrgSurface } from "@/lib/auth/org-permissions";

// Column order follows the tracks, not the rank ladder: governance, finance,
// operations, then the member roles.
const ROLES: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "SUPPORT",
  "EXPERT",
  "LEARNER",
];

const HEADER: Record<MemberRole, string> = {
  OWNER: "Owner",
  MAINTAINER: "Maintainer",
  BILLING_ADMIN: "Billing admin",
  MANAGER: "Manager",
  SUPPORT: "Support",
  EXPERT: "Expert",
  LEARNER: "Learner",
};

function row(key: OrgSurface): string {
  const cells = ROLES.map((role) =>
    ORG_PERMISSIONS[key].has(role) ? "✓" : "—",
  );
  return `| \`${key}\` | ${cells.join(" | ")} |`;
}

function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The sentence that introduces one surface's table. */
function leadIn(surface: string, count: number): string {
  const subject =
    count === 1 ? "The key below governs" : `The ${count} keys below govern`;
  return `${subject} the \`${surface}\` surface.`;
}

function main(): void {
  // Code-unit order, not localeCompare: the output must not depend on the
  // machine's collation.
  const keys = (Object.keys(ORG_PERMISSIONS) as OrgSurface[]).sort(byCodeUnit);
  const groups = new Map<string, OrgSurface[]>();
  for (const key of keys) {
    const surface = key.split(".")[0];
    groups.set(surface, [...(groups.get(surface) ?? []), key]);
  }

  const out: string[] = [
    "## Org role matrix",
    "",
    "This table is generated from `lib/auth/org-permissions.ts` by `scripts/utils/print-org-role-matrix.ts`, so edit the code and regenerate rather than editing the table.",
    "Each row is one permission key, and a tick means the role holds it.",
    "A platform admin passes every org gate as a synthetic Owner.",
    "Capability gates such as `canSponsor` and `canHost` are checked separately at each route, so a tick is necessary but not always sufficient.",
    "",
  ];
  for (const [surface, list] of groups) {
    out.push(
      `### \`${surface}\``,
      "",
      leadIn(surface, list.length),
      "",
      `| Key | ${ROLES.map((r) => HEADER[r]).join(" | ")} |`,
      `|---|${ROLES.map(() => ":-:").join("|")}|`,
      ...list.map(row),
      "",
    );
  }
  process.stdout.write(out.join("\n"));
}

main();
