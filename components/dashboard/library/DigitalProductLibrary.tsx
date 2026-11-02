import Link from "next/link";
import { FileDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ReportProductButton } from "@/components/digital-products/ReportProductButton";
import { BuyerFileList } from "@/components/digital-products/BuyerFileList";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import type { LibraryProduct } from "@/lib/data/digital-product-library";

/** The buyer's purchased and claimed products, each with its current files. */
export function DigitalProductLibrary({
  products,
}: Readonly<{ products: LibraryProduct[] }>) {
  if (products.length === 0) {
    return (
      <EmptyState
        variant="page"
        icon={FileDown}
        title="No digital products yet"
        description="E-books, templates and other files you buy or claim from experts appear here, ready to download."
        action={
          <Button asChild size="sm">
            <Link href="/explore/experts">Find experts</Link>
          </Button>
        }
      />
    );
  }
  return (
    <ul className="space-y-4">
      {products.map((product) => (
        <li key={product.purchaseId}>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <Link
                    href={`/explore/products/${product.slug}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {product.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {DIGITAL_PRODUCT_CATEGORY_LABEL[product.category]}
                    {product.creatorName ? ` · by ${product.creatorName}` : ""}
                    {" · "}
                    {product.purchasedAt.toLocaleDateString("en-IN", {
                      dateStyle: "medium",
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {product.updated && !product.takenDown && (
                    <StatusBadge label="Updated" tone="info" />
                  )}
                  {product.takenDown && (
                    <StatusBadge label="Unavailable" tone="neutral" />
                  )}
                </div>
              </div>
              {product.takenDown ? (
                <p className="text-sm text-muted-foreground">
                  {product.free
                    ? "This product was taken down, so its files can no longer be downloaded."
                    : "This product was taken down, so its files can no longer be downloaded. Contact support about a refund."}
                </p>
              ) : (
                <BuyerFileList
                  productId={product.productId}
                  files={product.files}
                  removed={product.removed}
                  free={product.free}
                />
              )}
              <ReportProductButton productId={product.productId} />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
