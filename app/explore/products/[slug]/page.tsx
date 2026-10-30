import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { FileText } from "lucide-react";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { goHref } from "@/lib/dashboard/go";
import { formatFileSize } from "@/lib/documents/document-utils";
import {
  getEntitledDigitalProductBySlug,
  getPublicDigitalProductBySlug,
} from "@/lib/data/digital-products-public";
import { quoteDigitalProductForBuyer } from "@/lib/payments/pricing/digital-product-price";
import { findDigitalProductEntitlement } from "@/lib/payments/digital-product-entitlement";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import {
  ProductPurchasePanel,
  type ProductViewer,
} from "./ProductPurchasePanel";
import { ReportProductButton } from "@/components/digital-products/ReportProductButton";

// Ownership is per viewer, so the page renders per request.
export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({
  params,
}: Readonly<{ params: Params }>): Promise<Metadata> {
  const { slug } = await params;
  const product = await getPublicDigitalProductBySlug(slug).catch(() => null);
  if (!product) return { title: "Product not found" };
  const creator = product.creator.name;
  return {
    title: `${product.title}${creator ? ` by ${creator}` : ""} — Familiarise`,
    description: product.subtitle ?? product.description.slice(0, 155),
  };
}

export default async function DigitalProductPage({
  params,
}: Readonly<{ params: Params }>) {
  const { slug } = await params;
  const session = await getSession();
  const user = session?.user;
  // A product off sale still opens for its buyers: not discoverable, no checkout.
  const product =
    (await getPublicDigitalProductBySlug(slug)) ??
    (user?.id ? await getEntitledDigitalProductBySlug(slug, user.id) : null);
  if (!product) notFound();

  let viewer: ProductViewer = { kind: "signed-out" };
  if (user?.id) {
    if (user.consultantProfileId === product.creator.consultantProfileId) {
      viewer = { kind: "owner" };
    } else if (
      await findDigitalProductEntitlement(prisma, product.id, user.id)
    ) {
      viewer = {
        kind: "owned",
        libraryHref: user.consulteeProfileId
          ? goHref("client", "products")
          : null,
      };
    } else {
      viewer = {
        kind: "buyer",
        name: user.name ?? undefined,
        email: user.email ?? undefined,
      };
    }
  }

  const quote =
    viewer.kind === "owned" || product.pricePaise === 0
      ? null
      : await quoteDigitalProductForBuyer({
          productId: product.id,
          pricePaise: product.pricePaise,
          buyerId: viewer.kind === "buyer" && user?.id ? user.id : null,
        });

  return (
    <div className="container mx-auto grid max-w-5xl gap-8 px-4 py-10 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-6">
        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-muted">
          {product.coverImagePath ? (
            <Image
              src={product.coverImagePath}
              alt={product.title}
              fill
              sizes="(min-width: 1024px) 600px, 100vw"
              className="object-cover"
            />
          ) : (
            <FileText
              className="h-16 w-16 text-muted-foreground/40"
              aria-hidden
            />
          )}
        </div>

        <div className="space-y-3">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {DIGITAL_PRODUCT_CATEGORY_LABEL[product.category]} ·{" "}
            {product.fileCount} {product.fileCount === 1 ? "file" : "files"}
          </span>
          <h1 className="text-2xl font-bold tracking-tight">{product.title}</h1>
          {product.subtitle && (
            <p className="text-muted-foreground">{product.subtitle}</p>
          )}
          <p className="text-sm text-muted-foreground">
            By{" "}
            <Link
              href={`/explore/experts/${product.creator.consultantProfileId}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {product.creator.name ?? "this expert"}
            </Link>
            {product.creator.headline ? ` · ${product.creator.headline}` : ""}
          </p>
          <p className="whitespace-pre-line text-sm leading-relaxed">
            {product.description}
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">What you get</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {product.files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 p-3">
                <FileText
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">
                  {file.originalName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatFileSize(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="h-fit space-y-4 rounded-xl border bg-card p-6 lg:sticky lg:top-24">
        <ProductPurchasePanel
          productId={product.id}
          slug={product.slug}
          title={product.title}
          quote={quote}
          viewer={viewer}
          files={product.files}
        />
        {user?.id && viewer.kind !== "owner" && (
          <ReportProductButton productId={product.id} />
        )}
      </aside>
    </div>
  );
}
