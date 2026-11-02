/**
 * The org nav's visible item set and phone tabs for every input the builder
 * accepts. Regrouping must leave this snapshot untouched.
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

it("every role × capability × suspension × profile keeps its item set", () => {
  const visible: Record<string, { paths: string[]; mobileTabs: string[] }> = {};
  for (const c of combos) {
    const nav = buildOrganizationNav({ orgId: "org-1", ...c });
    visible[key(c)] = {
      paths: flattenNav(nav)
        .map((i) => i.path)
        .sort(),
      mobileTabs: nav.mobileTabs,
    };
  }
  expect(Object.keys(visible)).toHaveLength(112);
  expect(visible).toMatchSnapshot();
});
