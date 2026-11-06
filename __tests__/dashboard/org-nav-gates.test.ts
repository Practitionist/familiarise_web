/**
 * The org nav's visible item set and phone tabs for every input the builder
 * accepts. Regrouping must leave this snapshot untouched; the only documented
 * difference, Host › Collaborations (operators' view of the merged route), is
 * asserted on its own.
 */
import type { MemberRole } from "@prisma/client";

import { buildOrganizationNav } from "@/lib/dashboard/nav/organization";
import { flattenNav } from "@/lib/dashboard/nav/types";

const ROLES: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
];
const FLAGS = [false, true] as const;

const combos = ROLES.flatMap((role) =>
  FLAGS.flatMap((canSponsor) =>
    FLAGS.flatMap((canHost) =>
      FLAGS.flatMap((suspended) =>
        FLAGS.map((delivers) => ({
          role,
          canSponsor,
          canHost,
          suspended,
          consultantProfileId: delivers ? "cp-1" : null,
        })),
      ),
    ),
  ),
);

const key = (c: (typeof combos)[number]) =>
  [
    c.role,
    c.canSponsor ? "sponsor" : "-",
    c.canHost ? "host" : "-",
    c.suspended ? "suspended" : "active",
    c.consultantProfileId ? "delivers" : "-",
  ].join(" · ");

/** Operators reach the merged Collaborations route behind Catalog's gate. */
const ADDED_SINCE_SNAPSHOT = "collaborations";

it("every role × capability × suspension × profile keeps its item set", () => {
  const visible: Record<string, { paths: string[]; mobileTabs: string[] }> = {};
  let added = 0;
  for (const c of combos) {
    const nav = buildOrganizationNav({ orgId: "org-1", ...c });
    const paths = flattenNav(nav).map((i) => i.path);
    const operator = paths.includes("catalog");
    // Operators get it with Catalog; experts already had it from My work.
    expect(!operator || paths.includes(ADDED_SINCE_SNAPSHOT)).toBe(true);
    if (operator) added += 1;
    expect(paths.filter((p) => p === ADDED_SINCE_SNAPSHOT).length).toBeLessThan(
      2,
    );
    visible[key(c)] = {
      paths: paths
        .filter((p) => !(operator && p === ADDED_SINCE_SNAPSHOT))
        .sort(),
      mobileTabs: nav.mobileTabs,
    };
  }
  expect(Object.keys(visible)).toHaveLength(112);
  // Active OWNER, MAINTAINER and MANAGER on a hosting org, with or without
  // sponsoring or a consultant profile.
  expect(added).toBe(12);
  expect(visible).toMatchSnapshot();
});
