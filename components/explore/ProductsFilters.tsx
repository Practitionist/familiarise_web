import Link from "next/link";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import type { ProductsQuery } from "@/lib/explore/products-query";

// One height for every control, so the row lines up with the Apply button.
const CONTROL_HEIGHT = "h-10";
const SELECT_CLASS = `${CONTROL_HEIGHT} appearance-none rounded-md border border-border bg-background pl-3 pr-9 text-sm`;

/** A native select with its own arrow, so the arrow sits the same distance from the edge in every browser. */
function SelectBox({
  id,
  label,
  name,
  defaultValue,
  children,
}: Readonly<{
  id: string;
  label: string;
  name: string;
  defaultValue: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        className={SELECT_CLASS}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}

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
            className={`${CONTROL_HEIGHT} w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm`}
          />
        </div>
      </div>
      <SelectBox
        id="products-category"
        label="Category"
        name="category"
        defaultValue={query.category ?? ""}
      >
        <option value="">All categories</option>
        {Object.entries(DIGITAL_PRODUCT_CATEGORY_LABEL).map(
          ([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ),
        )}
      </SelectBox>
      <SelectBox
        id="products-price"
        label="Price"
        name="price"
        defaultValue={query.price ?? ""}
      >
        <option value="">Free and paid</option>
        <option value="free">Free</option>
        <option value="paid">Paid</option>
      </SelectBox>
      <SelectBox
        id="products-sort"
        label="Sort by"
        name="sort"
        defaultValue={query.sort}
      >
        {Object.entries(SORT_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectBox>
      <Button type="submit" className={CONTROL_HEIGHT}>
        Apply
      </Button>
      {filtered && (
        <Button asChild variant="ghost" className={CONTROL_HEIGHT}>
          <Link href="/explore/products">Clear</Link>
        </Button>
      )}
    </form>
  );
}
