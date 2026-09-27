/**
 * #1527 — the org Library's scope gate and query contract: Mine for any
 * ACTIVE or SUSPENDED member, Everyone only for an ACTIVE `operations.read`
 * role; unknown filter values drop instead of failing.
 */

import {
  flattenLibrary,
  libraryScopeFor,
  parseLibraryQuery,
} from "@/lib/library/library-query";

describe("org Library query", () => {
  it("gates Everyone on an ACTIVE operations.read role", () => {
    const scope = (role: never, status: never, requested = "everyone") =>
      libraryScopeFor(requested, { role, status });
    expect(scope("MANAGER" as never, "ACTIVE" as never)).toBe("everyone");
    expect(scope("LEARNER" as never, "ACTIVE" as never)).toBeNull();
    expect(scope("BILLING_ADMIN" as never, "ACTIVE" as never)).toBeNull();
    expect(scope("OWNER" as never, "SUSPENDED" as never)).toBeNull();
    expect(scope("LEARNER" as never, "SUSPENDED" as never, "mine")).toBe(
      "mine",
    );
  });

  it("parses leniently and flattens groups with their session", () => {
    const sp = new URLSearchParams(
      "kind=TRIAL&from=2026-02-30x&source=mine&page=0&q=%20cv%20",
    );
    expect(parseLibraryQuery((k) => sp.get(k))).toEqual({
      q: "cv",
      kind: null,
      from: null,
      to: null,
      source: "mine",
      page: 1,
    });
    const session = {
      appointmentId: "a",
      kind: "CLASS",
      title: "T",
      startsAt: null,
      expertName: null,
    } as const;
    expect(flattenLibrary([{ session, files: [{ id: "f" }] }])).toEqual([
      { id: "f", session },
    ]);
  });
});
