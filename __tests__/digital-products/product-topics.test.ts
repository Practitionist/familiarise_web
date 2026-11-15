/** @jest-environment node */
const mockFindMany = jest.fn();

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
    consultantProfile: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
    },
  },
}));

import { listProductTopics } from "../../lib/data/digital-products-public";

const expert = (id: string, name: string, products: number) => ({
  domain: { id, name },
  _count: { digitalProducts: products },
});

describe("listProductTopics", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sums each field's products from database counts, most first", async () => {
    mockFindMany.mockResolvedValue([
      expert("d-law", "Law", 6_000),
      expert("d-art", "Art", 1),
      expert("d-law", "Law", 2),
      expert("d-bio", "Biology", 1),
    ]);

    await expect(listProductTopics()).resolves.toEqual([
      { id: "d-law", name: "Law", count: 6_002 },
      { id: "d-art", name: "Art", count: 1 },
      { id: "d-bio", name: "Biology", count: 1 },
    ]);
  });

  it("reads live experts with a product on sale, without a row cap", async () => {
    mockFindMany.mockResolvedValue([]);

    await listProductTopics();

    const [args] = mockFindMany.mock.calls[0];
    expect(args.take).toBeUndefined();
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.digitalProducts.some).toEqual(
      args.select._count.select.digitalProducts.where,
    );
    expect(args.where.digitalProducts.some).toMatchObject({
      status: "PUBLISHED",
      takenDownAt: null,
    });
  });
});
