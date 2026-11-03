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
  it("labels a paid price as before GST and a free one as Free", async () => {
    mockList.mockResolvedValue([card("a", 50000), card("b", 0)]);
    render(await ProductsGrid());
    expect(screen.getByText("₹500.00 + GST")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
  });
});
