/** @jest-environment node */
const mockFindMany = jest.fn();
const mockGroupBy = jest.fn();
const mockCount = jest.fn();

jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T>(fn: T) => fn,
}));
jest.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    digitalProduct: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      count: (...a: unknown[]) => mockCount(...a),
    },
    digitalProductPurchase: { groupBy: (...a: unknown[]) => mockGroupBy(...a) },
  },
}));

import { listPublicDigitalProducts } from "../../lib/data/digital-products-public";
import { parseProductsQuery } from "../../lib/explore/products-query";

const row = (id: string) => ({
  id,
  slug: id,
  title: id,
  subtitle: null,
  category: "TEMPLATE",
  pricePaise: 0,
  coverImagePath: null,
  _count: { assets: 1 },
  consultantProfile: { id: "c1", user: { name: "Asha" } },
});

describe("Most purchased sort", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Candidates arrive newest first; b and c are level on sales, a has none.
    mockFindMany.mockImplementation(
      async (args: { where: { id?: { in: string[] } } }) =>
        args.where.id
          ? args.where.id.in.map(row).reverse()
          : [
              { id: "a", publishedAt: new Date("2026-11-03") },
              { id: "b", publishedAt: new Date("2026-11-02") },
              { id: "c", publishedAt: new Date("2026-11-01") },
            ],
    );
    mockGroupBy.mockResolvedValue([
      { productId: "b", _count: { _all: 2 } },
      { productId: "c", _count: { _all: 2 } },
    ]);
    mockCount.mockResolvedValue(3);
  });

  it("orders by completed purchases, newest first on a tie", async () => {
    const page = await listPublicDigitalProducts(
      parseProductsQuery({ sort: "popular", q: "x" }),
    );
    expect(page.items.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(page.total).toBe(3);
  });

  it("counts only SUCCEEDED purchases", async () => {
    await listPublicDigitalProducts(
      parseProductsQuery({ sort: "popular", q: "x" }),
    );
    expect(mockGroupBy.mock.calls[0][0].where.status).toBe("SUCCEEDED");
  });
});
