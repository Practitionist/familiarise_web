import {
  parseProductsTab,
  replaysIndexHref,
} from "@/lib/explore/products-tabs";

const mockRedirect = jest.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
jest.mock("next/navigation", () => ({
  permanentRedirect: (url: string) => mockRedirect(url),
}));

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

describe("/explore/recordings redirect", () => {
  it("permanently redirects to the Replays tab", async () => {
    const { default: Page } = await import("@/app/explore/recordings/page");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "REDIRECT:/explore/products?tab=replays",
    );
  });

  it("keeps the query and replaces a stale tab", () => {
    expect(
      replaysIndexHref({ q: "go", tab: "products", tag: ["a", "b"] }),
    ).toBe("/explore/products?q=go&tag=a&tag=b&tab=replays");
  });
});
