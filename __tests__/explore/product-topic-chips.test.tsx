import { render, screen } from "@testing-library/react";
import { ProductTopicChips } from "@/components/explore/ProductTopicChips";
import { productTopicPath } from "@/lib/explore/domain-slug";

const mockTopics = jest.fn();
jest.mock("@/lib/data/digital-products-public", () => ({
  listProductTopics: () => mockTopics(),
}));

const TOPICS = [
  { id: "d1", name: "Technology", count: 4 },
  { id: "d2", name: "Creative Arts", count: 1 },
];

async function renderChips(activeId?: string) {
  render(await ProductTopicChips({ activeId }));
}

describe("productTopicPath", () => {
  it("slugs the field name under the products tree", () => {
    expect(productTopicPath("Creative Arts")).toBe(
      "/explore/products/c/creative-arts",
    );
  });
});

describe("ProductTopicChips", () => {
  beforeEach(() => mockTopics.mockResolvedValue(TOPICS));

  it("links each field to its own page with a product count", async () => {
    await renderChips();
    const link = screen.getByRole("link", { name: /Creative Arts/ });
    expect(link).toHaveAttribute("href", "/explore/products/c/creative-arts");
    expect(link).toHaveTextContent("1");
  });

  it("marks All current on the unfiltered library", async () => {
    await renderChips();
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks only the active field current on a field page", async () => {
    await renderChips("d1");
    expect(screen.getByRole("link", { name: /Technology/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "All" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders nothing when no field has products", async () => {
    mockTopics.mockResolvedValue([]);
    await renderChips();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
