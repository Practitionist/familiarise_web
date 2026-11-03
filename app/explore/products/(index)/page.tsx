import { Suspense } from "react";
import Link from "next/link";
import { ProductsGrid } from "@/components/explore/ProductsGrid";
import { ReplaysGrid } from "@/components/explore/ReplaysGrid";
import { PRODUCTS_TABS, parseProductsTab } from "@/lib/explore/products-tabs";

export const metadata = {
  title: "Digital products and replays | Familiarise",
  description:
    "Files and replays from verified consultants: e-books, templates, packs and recorded sessions.",
};

export default async function ExploreProductsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const tab = parseProductsTab((await searchParams).tab);

  return (
    <div className="container mx-auto px-4 py-10 space-y-8">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          Digital products and replays
        </h1>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Pay once and keep it: files from experts, and replays of their
          sessions.
        </p>
      </header>
      <nav
        aria-label="Products sections"
        className="flex justify-center gap-1 border-b"
      >
        {PRODUCTS_TABS.map(({ id, label }) => (
          <Link
            key={id}
            href={`/explore/products?tab=${id}`}
            aria-current={id === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              id === tab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <Suspense
        fallback={
          <div className="py-24 text-center text-muted-foreground">
            Loading…
          </div>
        }
      >
        {tab === "replays" ? <ReplaysGrid /> : <ProductsGrid />}
      </Suspense>
    </div>
  );
}
