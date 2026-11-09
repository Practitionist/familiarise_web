import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, FileText } from "lucide-react";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { formatFileSize } from "@/lib/documents/document-utils";
import { getDigitalProductForViewer } from "@/lib/data/digital-products-public";
import { quoteDigitalProductForBuyer } from "@/lib/payments/pricing/digital-product-price";
import {
  findDigitalProductEntitlement,
  findDigitalProductRefund,
} from "@/lib/payments/digital-product-entitlement";
import {
  DIGITAL_PRODUCT_CATEGORY_LABEL,
  digitalProductLibraryHref,
} from "@/lib/digital-products/constants";
import { readBuyerFiles } from "@/lib/digital-products/buyer-files";
import {
  ProductPurchasePanel,
  type ProductViewer,
} from "./ProductPurchasePanel";
import {
  PublicBreadcrumb,
  publicBreadcrumbItems,
} from "@/components/explore/PublicBreadcrumb";
import { ReportProductButton } from "@/components/digital-products/ReportProductButton";

// Ownership is per viewer, so the page renders per request.
export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Set by the download route when a browser follows a link to a file that is gone. */
const DOWNLOAD_NOTICES: Record<string, string> = {
  "file-removed":
    "The expert removed that file, so its link no longer works. Your current files are below.",
  "file-missing":
    "That download link is out of date. Your current files are below.",
};

export async function generateMetadata({
  params,
}: Readonly<{ params: Params }>): Promise<Metadata> {
  const { slug } = await params;
  const session = await getSession();
  const product = await getDigitalProductForViewer(
    slug,
    session?.user?.id ?? null,
  ).catch(() => null);
  if (!product) {
    return { title: "Product not found", robots: { index: false } };
  }
  const creator = product.creator.name;
  return {
    title: `${product.title}${creator ? ` by ${creator}` : ""} — Familiarise`,
    description: product.subtitle ?? product.description.slice(0, 155),
  };
}

export default async function DigitalProductPage({
  params,
  searchParams,
}: Readonly<{ params: Params; searchParams?: SearchParams }>) {
  const { slug } = await params;
  const noticeKey = (await searchParams)?.notice;
  const notice =
    typeof noticeKey === "string"
      ? (DOWNLOAD_NOTICES[noticeKey] ?? null)
      : null;
  const session = await getSession();
  const user = session?.user;
  // A product off sale still opens for its buyers: not discoverable, no checkout.
  const product = await getDigitalProductForViewer(slug, user?.id ?? null);
  if (!product) notFound();

  let viewer: ProductViewer = { kind: "signed-out" };
  if (user?.id) {
    if (user.consultantProfileId === product.creator.consultantProfileId) {
      viewer = { kind: "owner" };
    } else {
      const entitlement = await findDigitalProductEntitlement(
        prisma,
        product.id,
        user.id,
      );
      if (entitlement) {
        const views = await readBuyerFiles([
          {
            id: entitlement.id,
            productId: product.id,
            createdAt: entitlement.createdAt,
          },
        ]);
        viewer = {
          kind: "owned",
          libraryHref: digitalProductLibraryHref(user),
          free: entitlement.amountPaise === 0,
          ...(views.get(entitlement.id) ?? { files: [], removed: [] }),
        };
      }
    }
    // Signed in, neither the owner nor holding it: a buyer.
    if (viewer.kind === "signed-out") {
      const refund = await findDigitalProductRefund(
        prisma,
        product.id,
        user.id,
      );
      viewer = {
        kind: "buyer",
        name: user.name ?? undefined,
        email: user.email ?? undefined,
        refundedAt: refund?.refundedAt.toISOString() ?? null,
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

  const expertHref = `/explore/experts/${product.creator.consultantProfileId}`;
  const libraryHref = viewer.kind === "owned" ? viewer.libraryHref : null;

  // DOM order is the mobile order: header, purchase panel, then the long description.
  return (
    <div className="container mx-auto grid max-w-5xl gap-x-8 gap-y-6 px-4 py-6 sm:py-10 lg:grid-cols-[1.6fr_1fr]">
      <div className="flex min-w-0 items-center justify-between gap-3 text-sm text-muted-foreground lg:col-span-2">
        <PublicBreadcrumb
          items={publicBreadcrumbItems(
            {
              id: product.creator.consultantProfileId,
              name: product.creator.name,
            },
            product.title,
          )}
        />
        {libraryHref && (
          <Link
            href={libraryHref}
            className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Back to library
          </Link>
        )}
      </div>

      <div className="min-w-0 space-y-6 lg:col-start-1">
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
          <h1 className="break-words text-2xl font-bold tracking-tight">
            {product.title}
          </h1>
          {product.subtitle && (
            <p className="text-muted-foreground">{product.subtitle}</p>
          )}
          <p className="text-sm text-muted-foreground">
            By{" "}
            <Link
              href={expertHref}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {product.creator.name ?? "this expert"}
            </Link>
            {product.creator.headline ? ` · ${product.creator.headline}` : ""}
          </p>
        </div>
      </div>

      <aside className="h-fit min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-6 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-2">
        {notice && (
          <p
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
          >
            {notice}
          </p>
        )}
        <ProductPurchasePanel
          productId={product.id}
          slug={product.slug}
          title={product.title}
          quote={quote}
          viewer={viewer}
        />
        {viewer.kind !== "owner" && (
          <Link
            href={`${expertHref}#sessions`}
            className="block rounded-lg border p-3 text-sm transition-colors hover:bg-muted"
          >
            <span className="font-medium">
              Book a session with {product.creator.name ?? "this expert"}
            </span>
            <span className="block text-xs text-muted-foreground">
              Talk it through 1:1 or see their other services.
            </span>
          </Link>
        )}
        {user?.id && viewer.kind !== "owner" && (
          <ReportProductButton productId={product.id} />
        )}
      </aside>

      <div className="min-w-0 space-y-6 lg:col-start-1">
        <p className="whitespace-pre-line break-words text-sm leading-relaxed">
          {product.description}
        </p>

        {/* A buyer who holds it sees these files, with downloads, in the panel. */}
        {viewer.kind !== "owned" && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">What you get</h2>
            <ul className="divide-y rounded-lg border text-sm">
              {product.files.map((file) => (
                <li key={file.id} className="flex items-center gap-3 p-3">
                  <FileText
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span
                    className="min-w-0 flex-1 break-words"
                    title={file.originalName}
                  >
                    {file.originalName}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatFileSize(file.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
