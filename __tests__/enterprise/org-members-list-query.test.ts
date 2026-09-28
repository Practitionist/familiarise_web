/**
 * #1527 — the Members list query: the URL defaults to Active, ERASED is never
 * listed, sorts map to stable orderBys and the role chips count without the
 * role filter.
 */

import { buildOrgMembersQuery } from "@/lib/data/org-members-query";
import {
  MembersListQuerySchema,
  membersListQueryFromUrl,
} from "@/schemas/organizations";

const fromUrl = (search: string) => {
  const sp = new URLSearchParams(search);
  return membersListQueryFromUrl((k) => sp.get(k));
};

describe("members list query (#1527)", () => {
  it("reads the URL with Active, name ascending and page 1 as defaults", () => {
    expect(fromUrl("")).toMatchObject({
      status: ["ACTIVE"],
      sort: "name",
      dir: "asc",
      page: 1,
      perPage: 25,
    });
    expect(fromUrl("role=LEARNER&sort=-joined&page=3")).toMatchObject({
      role: ["LEARNER"],
      sort: "joined",
      dir: "desc",
      page: 3,
    });
    // Bad values fall back instead of failing the list.
    const fallback = fromUrl("role=NOPE&status=ERASED&sort=-bogus");
    expect(fallback.role).toBeUndefined();
    expect(fallback).toMatchObject({
      status: ["ACTIVE"],
      sort: "name",
      dir: "asc",
    });
  });

  it("rejects ERASED at the API and never lists it by default", () => {
    expect(MembersListQuerySchema.safeParse({ status: "ERASED" }).success).toBe(
      false,
    );
    const { where, countsWhere, orderBy } = buildOrgMembersQuery(
      "org",
      MembersListQuerySchema.parse({ role: "EXPERT,LEARNER", sort: "role" }),
    );
    const listed = ["ACTIVE", "PENDING", "SUSPENDED", "REMOVED"];
    expect(where).toMatchObject({
      status: { in: listed },
      role: { in: ["EXPERT", "LEARNER"] },
    });
    expect(countsWhere).toEqual({
      organizationId: "org",
      status: { in: listed },
    });
    expect(orderBy[0]).toEqual({ role: "asc" });
    expect(orderBy.at(-1)).toEqual({ id: "asc" });
  });
});
