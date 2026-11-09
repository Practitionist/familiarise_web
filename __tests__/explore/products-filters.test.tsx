/** @jest-environment node */
import { renderToStaticMarkup } from "react-dom/server";
import { ProductsFilters } from "@/components/explore/ProductsFilters";
import { parseProductsQuery } from "@/lib/explore/products-query";

const html = (raw: Record<string, string> = {}) =>
  renderToStaticMarkup(<ProductsFilters query={parseProductsQuery(raw)} />);

describe("ProductsFilters", () => {
  it("gives the search box, every select and the buttons one height", () => {
    const markup = html({ q: "cv" });
    const heights = markup.match(/class="[^"]*"/g) ?? [];
    const controls = heights.filter(
      (c) =>
        c.includes("appearance-none") ||
        c.includes("pl-9") ||
        c.includes("bg-primary") ||
        c.includes("hover:bg-accent"),
    );
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const control of controls) expect(control).toContain("h-10");
  });

  it("draws its own arrow on each of the three selects", () => {
    expect(html().match(/lucide-chevron-down/g)).toHaveLength(3);
  });

  it("preselects the values from the URL and shows Clear only when filtered", () => {
    const filtered = html({
      category: "TEMPLATE",
      price: "free",
      sort: "price-asc",
    });
    expect(filtered).toContain('<option value="TEMPLATE" selected');
    expect(filtered).toContain("Clear");
    expect(html()).not.toContain("Clear");
  });
});
