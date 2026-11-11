"use client";

import Image from "next/image";
import Link from "next/link";
import { FileDown, FileText } from "lucide-react";

import type { PublicProductCard } from "@/lib/data/digital-products-public";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import { productPriceLabel } from "@/lib/digital-products/price-label";
import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";

/** The expert's files on sale; each card opens the product page to buy. */
export function DigitalProductsSection({
  products,
}: Readonly<{ products: PublicProductCard[] }>) {
  const { gstRegistered } = useBuyerPrice();
  if (products.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-6 py-5 md:px-8">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
          <FileDown className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Digital products
          </h2>
          <p className="text-sm text-muted-foreground">
            Pay once, download any time.
          </p>
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-5 p-6 md:grid-cols-2 md:p-8 xl:grid-cols-3">
        {products.map((product) => (
          <li key={product.id}>
            <Link
              href={`/explore/products/${product.slug}`}
              className="group flex h-full flex-col overflow-hidden rounded-xl border border-border transition-colors hover:border-foreground/30"
            >
              <div className="relative flex aspect-video items-center justify-center bg-muted">
                {product.coverImagePath ? (
                  <Image
                    src={product.coverImagePath}
                    alt=""
                    fill
                    sizes="(min-width: 1280px) 300px, (min-width: 768px) 50vw, 100vw"
                    className="object-cover"
                  />
                ) : (
                  <FileText
                    className="h-10 w-10 text-muted-foreground/40"
                    aria-hidden
                  />
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1 p-4">
                <p className="line-clamp-2 font-medium group-hover:underline">
                  {product.title}
                </p>
                {product.subtitle && (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {product.subtitle}
                  </p>
                )}
                <p className="mt-auto pt-2 text-sm text-muted-foreground">
                  {DIGITAL_PRODUCT_CATEGORY_LABEL[product.category]} ·{" "}
                  {product.fileCount}{" "}
                  {product.fileCount === 1 ? "file" : "files"} ·{" "}
                  <span className="font-medium text-foreground">
                    {productPriceLabel(product.pricePaise, gstRegistered)}
                  </span>
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
