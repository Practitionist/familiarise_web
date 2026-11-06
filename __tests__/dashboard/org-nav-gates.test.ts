/**
 * The org nav's visible item set and phone tabs for every input the builder
 * accepts. Regrouping must leave this snapshot untouched; the only documented
 * difference, Host › Collaborators, is asserted on its own.
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

/** Collaborators split out of Catalog as its own item, behind Catalog's gate. */
const ADDED_SINCE_SNAPSHOT = "collaborators";

it("every role × capability × suspension × profile keeps its item set", () => {
  const visible: Record<string, { paths: string[]; mobileTabs: string[] }> = {};
  let added = 0;
  for (const c of combos) {
    const nav = buildOrganizationNav({ orgId: "org-1", ...c });
    const paths = flattenNav(nav).map((i) => i.path);
    expect(paths.includes(ADDED_SINCE_SNAPSHOT)).toBe(
      paths.includes("catalog"),
    );
    if (paths.includes(ADDED_SINCE_SNAPSHOT)) added += 1;
    visible[key(c)] = {
      paths: paths.filter((p) => p !== ADDED_SINCE_SNAPSHOT).sort(),
      mobileTabs: nav.mobileTabs,
    };
  }
  expect(Object.keys(visible)).toHaveLength(112);
  // Active OWNER, MAINTAINER and MANAGER on a hosting org, with or without
  // sponsoring or a consultant profile.
  expect(added).toBe(12);
  expect(visible).toMatchSnapshot();
});
