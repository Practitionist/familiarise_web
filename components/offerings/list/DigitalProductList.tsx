"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Pencil } from "lucide-react";
import { z } from "zod";
import { DigitalProductCategory, DigitalProductStatus } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import type { Tone } from "@/lib/ui/tone";
import { DIGITAL_PRODUCT_CATEGORY_LABEL } from "@/lib/digital-products/constants";
import { formatCurrencyAmount } from "@/utils/formatting";

export const MY_DIGITAL_PRODUCTS_QUERY_KEY = ["digital-products", "mine"];

const rowSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  category: z.nativeEnum(DigitalProductCategory),
  pricePaise: z.number(),
  status: z.nativeEnum(DigitalProductStatus),
  takenDownAt: z.string().nullable(),
  _count: z.object({ assets: z.number(), purchases: z.number() }),
});
type ProductRow = z.infer<typeof rowSchema>;

function statusChip(row: ProductRow): { label: string; tone: Tone } {
  if (row.takenDownAt) return { label: "Taken down", tone: "critical" };
  if (row.status === "PUBLISHED")
    return { label: "Published", tone: "success" };
  if (row.status === "ARCHIVED") return { label: "Off sale", tone: "neutral" };
  return { label: "Draft", tone: "neutral" };
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The consultant's own digital products, newest first. */
export function DigitalProductList({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: MY_DIGITAL_PRODUCTS_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/digital-products");
      if (!res.ok) throw new Error(`Failed to load products (${res.status})`);
      return z.object({ data: z.array(rowSchema) }).parse(await res.json())
        .data;
    },
  });

  if (isPending) return <PlannerSkeleton />;
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load your digital products"
        description="Try again in a moment."
        onRetry={() => void refetch()}
      />
    );
  }
  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <FileText className="h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Sell a file people can download</p>
          <p className="max-w-md text-sm text-muted-foreground">
            E-books, templates, ZIP bundles, printables and audio. Buyers pay
            once and keep access for life.
          </p>
          <Button asChild size="sm">
            <Link
              href={`/dashboard/consultant/${consultantId}/offerings/digital-product/new`}
            >
              New digital product
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {data.map((row) => {
        const chip = statusChip(row);
        return (
          <li key={row.id}>
            <Card className="h-full">
              <CardContent className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 font-medium">{row.title}</p>
                  <StatusBadge label={chip.label} tone={chip.tone} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {DIGITAL_PRODUCT_CATEGORY_LABEL[row.category]} ·{" "}
                  {row.pricePaise === 0
                    ? "Free"
                    : formatCurrencyAmount(row.pricePaise, "INR")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {plural(row._count.assets, "file", "files")} ·{" "}
                  {plural(row._count.purchases, "buyer", "buyers")}
                </p>
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/dashboard/consultant/${consultantId}/offerings/digital-product/${row.id}/edit`}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      Edit
                    </Link>
                  </Button>
                  {row.status === "PUBLISHED" && !row.takenDownAt && (
                    <Button asChild size="sm" variant="ghost">
                      <Link
                        href={`/explore/products/${row.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View page
                        <ExternalLink className="ml-1 h-3 w-3" aria-hidden />
                      </Link>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
