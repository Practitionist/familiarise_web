/**
 * @jest-environment node
 */

/** The Audit tab's filters, as they arrive from a drill-through URL or the API query. */

import {
  OpsLogFiltersSchema,
  opsLogFiltersFromSearchParams,
} from "../../schemas/ops-log";

describe("OpsLogFiltersSchema", () => {
  it("accepts action and since, trims, and drops blanks", () => {
    expect(
      OpsLogFiltersSchema.parse({
        action: " support.refund.review ",
        since: "2026-10-01",
        surface: "",
      }),
    ).toEqual({ action: "support.refund.review", since: "2026-10-01" });
  });

  it("accepts an ISO instant and refuses a non-date since", () => {
    expect(
      OpsLogFiltersSchema.safeParse({ since: "2026-09-22T02:00:00.000Z" })
        .success,
    ).toBe(true);
    expect(OpsLogFiltersSchema.safeParse({ since: "last week" }).success).toBe(
      false,
    );
  });

  it.each(["2", "2026-", "2026-10", "2026-10-2", "2026-02-30", "2026-10-22T0"])(
    "refuses the partial or impossible date %s that Date.parse would accept",
    (since) => {
      expect(OpsLogFiltersSchema.safeParse({ since }).success).toBe(false);
    },
  );

  it("accepts an instant with an offset", () => {
    expect(
      OpsLogFiltersSchema.safeParse({ since: "2026-10-22T07:30:00+05:30" })
        .success,
    ).toBe(true);
  });
});

describe("opsLogFiltersFromSearchParams", () => {
  it("reads the drill-through filters from the page URL", () => {
    expect(
      opsLogFiltersFromSearchParams({
        actorUserId: "staff-1",
        action: "support.hold.apply",
        since: "2026-09-22T02:00:00.000Z",
        tab: "ignored",
      }),
    ).toEqual({
      actorUserId: "staff-1",
      action: "support.hold.apply",
      since: "2026-09-22T02:00:00.000Z",
    });
  });

  it("drops a bad value instead of failing the page, and takes the first repeat", () => {
    expect(
      opsLogFiltersFromSearchParams({
        since: "not-a-date",
        targetId: ["a", "b"],
        surface: "x".repeat(201),
      }),
    ).toEqual({ targetId: "a" });
  });
});
