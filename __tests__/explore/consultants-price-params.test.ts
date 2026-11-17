/**
 * @jest-environment node
 */

/** A price bound is a safe non-negative integer in paise; anything else is ignored, never a 500. */
const findMany = jest.fn(async (_args: unknown) => []);
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findMany: (args: unknown) => findMany(args),
      count: jest.fn(async () => 0),
    },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/consultants/route";
import { filtersFromSearchParams } from "@/app/explore/experts/utils";

/** The price bounds the route put on the plan filter, or null for none. */
async function priceBound(minPrice: string) {
  const res = await GET(
    new NextRequest(
      `http://x/api/user/consultants?search=yoga&minPrice=${encodeURIComponent(minPrice)}`,
    ),
  );
  expect(res.status).toBe(200);
  const where = JSON.stringify(
    (findMany.mock.calls.at(-1)?.[0] as { where: unknown }).where,
  );
  const match = /"price":(\{[^}]*\})/.exec(where);
  return match ? JSON.parse(match[1]) : null;
}

it.each(["Infinity", "1.5", "-1", "1e400", "abc"])(
  "ignores minPrice=%s",
  async (raw) => {
    expect(await priceBound(raw)).toBeNull();
  },
);

it("keeps minPrice=500 as a bound", async () => {
  expect(await priceBound("500")).toEqual({ gte: 500 });
});

it.each([
  ["1.5", undefined],
  ["-1", undefined],
  ["Infinity", undefined],
  ["500", 500],
])("the explore page reads a price bound of %s as %s", (raw, bound) => {
  const filters = filtersFromSearchParams(
    new URLSearchParams({ minPrice: raw, maxPrice: raw }),
  );
  expect(filters.minPrice).toBe(bound);
  expect(filters.maxPrice).toBe(bound);
});
