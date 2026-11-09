import Link from "next/link";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import type { ProductsQuery } from "@/lib/explore/products-query";

const SELECT_CLASS =
  "h-10 rounded-md border border-border bg-background px-3 text-sm";

const SORT_LABELS: Record<ProductsQuery["sort"], string> = {
  newest: "Newest",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
};

/** A plain GET form: filtering is a link a visitor can share, and needs no client JavaScript. */
export function ProductsFilters({ query }: Readonly<{ query: ProductsQuery }>) {
  const filtered = Boolean(query.q || query.category || query.price);
  return (
    <form
      method="get"
      role="search"
      aria-label="Filter digital products"
      className="flex flex-wrap items-end gap-3"
    >
      <div className="min-w-[14rem] flex-1">
        <label htmlFor="products-q" className="sr-only">
          Search products
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            id="products-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            placeholder="Search by title or expert"
            maxLength={100}
            className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm"
          />
        </div>
      </div>
      <div>
        <label htmlFor="products-category" className="sr-only">
          Category
        </label>
        <select
          id="products-category"
          name="category"
          defaultValue={query.category ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">All categories</option>
          {Object.entries(DIGITAL_PRODUCT_CATEGORY_LABEL).map(
            ([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ),
          )}
        </select>
      </div>
      <div>
        <label htmlFor="products-price" className="sr-only">
          Price
        </label>
        <select
          id="products-price"
          name="price"
          defaultValue={query.price ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">Free and paid</option>
          <option value="free">Free</option>
          <option value="paid">Paid</option>
        </select>
      </div>
      <div>
        <label htmlFor="products-sort" className="sr-only">
          Sort by
        </label>
        <select
          id="products-sort"
          name="sort"
          defaultValue={query.sort}
          className={SELECT_CLASS}
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit">Apply</Button>
      {filtered && (
        <Button asChild variant="ghost">
          <Link href="/explore/products">Clear</Link>
        </Button>
      )}
    </form>
  );
}
