import { Suspense } from "react";
import { ProductsGrid } from "@/components/explore/ProductsGrid";

export const metadata = {
  title: "Digital products | Familiarise",
  description:
    "E-books, templates and packs from verified consultants. Pay once and keep it.",
};

export default function ExploreProductsPage() {
  return (
    <div className="container mx-auto px-4 py-10 space-y-8">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Digital products</h1>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Pay once and keep it: files from experts.
        </p>
      </header>
      <Suspense
        fallback={
          <div className="py-24 text-center text-muted-foreground">
            Loading…
          </div>
        }
      >
        <ProductsGrid />
      </Suspense>
    </div>
  );
}
