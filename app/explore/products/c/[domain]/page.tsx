import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProductTopicChips } from "@/components/explore/ProductTopicChips";
import { ProductsFilters } from "@/components/explore/ProductsFilters";
import { ProductsGrid } from "@/components/explore/ProductsGrid";
import { getExpertsMetadata } from "@/lib/data/explore-experts";
import { findDomainBySlug, productTopicPath } from "@/lib/explore/domain-slug";
import { parseProductsQuery } from "@/lib/explore/products-query";

type Params = Promise<{ domain: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function loadDomain(slug: string) {
  const { domains } = await getExpertsMetadata();
  return findDomainBySlug(domains, slug) ?? null;
}

export async function generateMetadata({
  params,
}: Readonly<{ params: Params }>): Promise<Metadata> {
  const domain = await loadDomain((await params).domain).catch(() => null);
  if (!domain) return { robots: { index: false } };
  const title = `${domain.name} digital products | Familiarise`;
  const description = `E-books, templates and packs from verified ${domain.name.toLowerCase()} experts. Pay once and keep it.`;
  return {
    title,
    description,
    alternates: { canonical: productTopicPath(domain.name) },
    openGraph: { title, description, url: productTopicPath(domain.name) },
  };
}

export default async function ProductsByFieldPage({
  params,
  searchParams,
}: Readonly<{ params: Params; searchParams: SearchParams }>) {
  const domain = await loadDomain((await params).domain);
  if (!domain) notFound();
  const query = parseProductsQuery(await searchParams);
  const basePath = productTopicPath(domain.name);

  return (
    <div className="container mx-auto px-4 py-10 space-y-8">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          {domain.name} digital products
        </h1>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Files from {domain.name.toLowerCase()} experts. Pay once and keep it.
        </p>
      </header>
      <ProductTopicChips activeId={domain.id} />
      <ProductsFilters query={query} basePath={basePath} />
      <Suspense
        key={JSON.stringify(query)}
        fallback={
          <div className="py-24 text-center text-muted-foreground">
            Loading…
          </div>
        }
      >
        <ProductsGrid query={query} basePath={basePath} domainId={domain.id} />
      </Suspense>
    </div>
  );
}
