/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

const mockList = jest.fn();
jest.mock("@/lib/data/digital-products-public", () => ({
  listPublicDigitalProducts: (n: number) => mockList(n),
}));

import { ProductsGrid } from "@/components/explore/ProductsGrid";

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
    mockList.mockResolvedValue([card("a", 50000), card("b", 0)]);
    render(await ProductsGrid());
    expect(screen.getByText("₹500.00")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
  });

  it("shows the all-in price with a GST note once registered", async () => {
    process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
    mockList.mockResolvedValue([card("a", 50000), card("b", 0)]);
    render(await ProductsGrid());
    expect(screen.getByText("₹590.00 incl. GST")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
  });
});
