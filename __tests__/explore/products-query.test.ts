import {
  parseProductsQuery,
  productsQueryString,
} from "@/lib/explore/products-query";

describe("products query", () => {
  it("defaults an empty URL to newest, page one, no filters", () => {
    expect(parseProductsQuery({})).toEqual({ sort: "newest", page: 1 });
  });

  it("reads valid filters", () => {
    expect(
      parseProductsQuery({
        q: "  resume ",
        category: "TEMPLATE",
        price: "free",
        sort: "price-asc",
        page: "3",
      }),
    ).toEqual({
      q: "resume",
      category: "TEMPLATE",
      price: "free",
      sort: "price-asc",
      page: 3,
    });
  });

  it("drops bad, repeated and out-of-range values instead of failing", () => {
    expect(
      parseProductsQuery({
        q: ["a", "b"],
        category: "NOPE",
        price: "cheap",
        sort: "random",
        page: "-4",
      }),
    ).toEqual({ sort: "newest", page: 1 });
    expect(parseProductsQuery({ page: "99999" }).page).toBe(1);
  });

  it("writes only non-default values back to the URL", () => {
    const query = parseProductsQuery({ q: "cv", sort: "price-desc" });
    expect(productsQueryString(query)).toBe("?q=cv&sort=price-desc");
    expect(productsQueryString(query, { page: 2 })).toBe(
      "?q=cv&sort=price-desc&page=2",
    );
    expect(productsQueryString(parseProductsQuery({}))).toBe("");
  });
});
