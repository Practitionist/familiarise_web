import { parseProductsTab } from "@/lib/explore/products-tabs";

describe("products index tab", () => {
  it.each([
    ["replays", "replays"],
    ["products", "products"],
    [undefined, "products"],
    ["nonsense", "products"],
    [["replays", "products"], "products"],
  ])("parses %j as %s", (input, expected) => {
    expect(parseProductsTab(input)).toBe(expected);
  });
});
