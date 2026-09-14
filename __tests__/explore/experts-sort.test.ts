/**
 * @jest-environment node
 */

/**
 * #1554 — with the blended `reviewCount` column gone, "Most Reviews" and
 * "trending" must still be two different orders, and neither may sink an
 * expert whose reviews are all group events.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { orderByForSort } from "@/lib/data/explore-experts";

it("Most Reviews orders on rated clients with rated events as the tie-break", () => {
  expect(orderByForSort("reviewCount")).toEqual([
    { ratedClientsOneToOne: "desc" },
    { ratedEventsGroup: "desc" },
  ]);
});

it("trending is recent review activity, not the same order as Most Reviews", () => {
  const trending = orderByForSort("trending");
  expect(trending).toEqual([
    { ratingAggregatedAt: { sort: "desc", nulls: "last" } },
    { ratedClientsOneToOne: "desc" },
  ]);
  expect(trending).not.toEqual(orderByForSort("reviewCount"));
});
