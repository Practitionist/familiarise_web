/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

const mockList = jest.fn();
jest.mock("@/lib/data/digital-products-public", () => ({
  listPublicDigitalProducts: (query: unknown) => mockList(query),
}));

import { ProductsGrid } from "@/components/explore/ProductsGrid";
import { parseProductsQuery } from "@/lib/explore/products-query";

const QUERY = parseProductsQuery({});
const page = (items: ReturnType<typeof card>[]) => ({
  items,
  total: items.length,
  page: 1,
  perPage: 24,
});

const card = (id: string, pricePaise: number) => ({
  id,
  slug: id,
  title: `Product ${id}`,
  subtitle: null,
  category: "TEMPLATE",
  pricePaise,
  coverImagePath: null,
  fileCount: 2,
  creator: { consultantProfileId: "c1", name: "Asha" },
});

describe("ProductsGrid price", () => {
  const OLD_GSTIN = process.env.PLATFORM_GSTIN;
  afterEach(() => {
    if (OLD_GSTIN === undefined) delete process.env.PLATFORM_GSTIN;
    else process.env.PLATFORM_GSTIN = OLD_GSTIN;
  });

  it("shows the plain price while unregistered and Free as Free", async () => {
    delete process.env.PLATFORM_GSTIN;
    mockList.mockResolvedValue(page([card("a", 50000), card("b", 0)]));
    render(await ProductsGrid({ query: QUERY }));
    expect(screen.getByText("₹500.00")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
  });

  it("shows the all-in price with a GST note once registered", async () => {
    process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
    mockList.mockResolvedValue(page([card("a", 50000), card("b", 0)]));
    render(await ProductsGrid({ query: QUERY }));
    expect(screen.getByText("₹590.00 incl. GST")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
  });
});

describe("ProductsGrid links", () => {
  it("links the title to the product and the expert's name to their profile", async () => {
    mockList.mockResolvedValue(page([card("a", 0)]));
    render(await ProductsGrid({ query: QUERY }));
    expect(screen.getByRole("link", { name: "Product a" })).toHaveAttribute(
      "href",
      "/explore/products/a",
    );
    expect(screen.getByRole("link", { name: "Asha" })).toHaveAttribute(
      "href",
      "/explore/experts/c1",
    );
  });
});

describe("ProductsGrid paging and empty states", () => {
  const paged = (pageNo: number, total: number, count: number) => ({
    items: Array.from({ length: count }, (_, i) => card(`p${pageNo}-${i}`, 0)),
    total,
    page: pageNo,
    perPage: 24,
  });
  const hrefs = () =>
    screen.queryAllByRole("link").map((a) => a.getAttribute("href"));

  it("links Previous and Next on a middle page and keeps the filters", async () => {
    mockList.mockResolvedValue(paged(2, 60, 24));
    const query = parseProductsQuery({ q: "cv", price: "free", page: "2" });
    render(await ProductsGrid({ query }));
    expect(screen.getByText("Showing 25–48 of 60")).toBeTruthy();
    expect(hrefs()).toEqual(
      expect.arrayContaining([
        "/explore/products?q=cv&price=free",
        "/explore/products?q=cv&price=free&page=3",
      ]),
    );
  });

  it("renders no pagination when everything fits on one page", async () => {
    mockList.mockResolvedValue(paged(1, 3, 3));
    render(await ProductsGrid({ query: QUERY }));
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });

  it("says nothing matched when a search has no results", async () => {
    mockList.mockResolvedValue({ items: [], total: 0, page: 1, perPage: 24 });
    render(await ProductsGrid({ query: parseProductsQuery({ q: "zzz" }) }));
    expect(screen.getByText("No products match your search")).toBeTruthy();
  });

  it("offers a way back when the page is past the last one", async () => {
    mockList.mockResolvedValue({ items: [], total: 30, page: 5, perPage: 24 });
    render(
      await ProductsGrid({
        query: parseProductsQuery({ page: "5", category: "TEMPLATE" }),
      }),
    );
    expect(screen.getByText("That page has no products")).toBeTruthy();
    expect(screen.queryByText("No digital products yet")).toBeNull();
    expect(hrefs()).toContain("/explore/products?category=TEMPLATE");
  });
});
