import Image from "next/image";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listPublicDigitalProducts } from "@/lib/data/digital-products-public";
import {
  productsQueryString,
  type ProductsQuery,
} from "@/lib/explore/products-query";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import { productPriceLabel } from "@/lib/digital-products/price-label";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";

export async function ProductsGrid({
  query,
  basePath = "/explore/products",
  domainId,
}: Readonly<{
  query: ProductsQuery;
  /** The page's own path, so paging links stay on a topic page. */
  basePath?: string;
  domainId?: string;
}>) {
  const {
    items: products,
    total,
    page,
    perPage,
  } = await listPublicDigitalProducts(query, domainId);
  const gstRegistered = isPlatformGstRegistered();
  const filtered = Boolean(query.q || query.category || query.price);

  if (products.length === 0 && page > 1 && total > 0) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        <p className="text-lg font-medium">That page has no products</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href={`${basePath}${productsQueryString(query, { page: 1 })}`}>
            Back to the first page
          </Link>
        </Button>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        <FileText className="mx-auto mb-4 h-12 w-12 opacity-40" aria-hidden />
        <p className="text-lg font-medium">
          {filtered
            ? "No products match your search"
            : "No digital products yet"}
        </p>
        <p className="mt-1 text-sm">
          {filtered
            ? "Try a different word, or clear the filters."
            : "Experts' e-books, templates and packs appear here once published."}
        </p>
      </div>
    );
  }

  const firstShown = (page - 1) * perPage + 1;
  const lastShown = firstShown + products.length - 1;
  const hasPrevious = page > 1;
  const hasNext = lastShown < total;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Showing {firstShown}–{lastShown} of {total}
      </p>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {products.map((product) => (
          <li key={product.id}>
            <Link
              href={`/explore/products/${product.slug}`}
              className="group flex h-full flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md"
            >
              <div className="relative flex aspect-video items-center justify-center bg-muted">
                {product.coverImagePath ? (
                  <Image
                    src={product.coverImagePath}
                    alt=""
                    fill
                    sizes="(min-width: 1280px) 300px, (min-width: 640px) 33vw, 100vw"
                    className="object-cover"
                  />
                ) : (
                  <FileText
                    className="h-10 w-10 text-muted-foreground/40"
                    aria-hidden
                  />
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {DIGITAL_PRODUCT_CATEGORY_LABEL[product.category]}
                  </span>
                  <span className="font-semibold text-primary">
                    {productPriceLabel(product.pricePaise, gstRegistered)}
                  </span>
                </div>
                <h3 className="line-clamp-2 text-sm font-medium transition-colors group-hover:text-primary">
                  {product.title}
                </h3>
                <p className="truncate text-xs text-muted-foreground">
                  {product.creator.name ?? "Expert"} · {product.fileCount}{" "}
                  {product.fileCount === 1 ? "file" : "files"}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {(hasPrevious || hasNext) && (
        <nav
          aria-label="Pagination"
          className="flex items-center justify-center gap-3"
        >
          {hasPrevious && (
            <Button asChild variant="outline">
              <Link
                href={`${basePath}${productsQueryString(query, { page: page - 1 })}`}
                rel="prev"
              >
                Previous
              </Link>
            </Button>
          )}
          {hasNext && (
            <Button asChild variant="outline">
              <Link
                href={`${basePath}${productsQueryString(query, { page: page + 1 })}`}
                rel="next"
              >
                Next
              </Link>
            </Button>
          )}
        </nav>
      )}
    </div>
  );
}
