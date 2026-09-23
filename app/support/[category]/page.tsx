import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";

import {
  SupportSidebar,
  SupportSidebarMobile,
} from "../_components/SupportSidebar";
import {
  articleUrl,
  articlesForCategory,
  getCategory,
} from "../_data/support-content";

export const revalidate = 3600;

// No generateStaticParams: these pages render on demand and join the ISR
// cache instead of prerendering at build. #1795 added ~50 support URLs and the
// Netlify build OOM'd (exit 137 at static page 166/334, 8 GB container) —
// cumulative prerender RSS is the constraint, and these pages touch no DB so
// first-hit generation is fast. Sitemap still lists every URL for crawlers.

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  const data = getCategory(category);
  if (!data) return { title: "Topic not found" };
  return {
    title: `${data.title} | Familiarise Help Center`,
    description: data.description,
  };
}

export default async function SupportCategoryPage({
  params,
}: {
  readonly params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const data = getCategory(category);
  if (!data) notFound();
  const articles = articlesForCategory(category);

  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        <nav
          aria-label="Breadcrumb"
          className="mb-6 text-sm text-muted-foreground"
        >
          <ol className="flex flex-wrap items-center gap-1.5">
            <li>
              <Link href="/support" className="hover:text-foreground">
                Help Center
              </Link>
            </li>
            <li aria-hidden>
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li className="text-foreground">{data.title}</li>
          </ol>
        </nav>

        <div className="flex gap-10">
          <SupportSidebar />
          <div className="min-w-0 flex-1">
            <SupportSidebarMobile />
            <h1 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight">
              {data.title}
            </h1>
            <p className="mt-3 max-w-2xl text-fluid-lg text-muted-foreground">
              {data.description}
            </p>

            <div className="mt-8 space-y-4">
              {articles.map((article) => (
                <Link
                  key={article.slug}
                  href={articleUrl(article)}
                  className="group block rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all hover:-translate-y-0.5 hover:shadow-elevation-2"
                >
                  <p className="font-semibold leading-snug group-hover:underline group-hover:underline-offset-4">
                    {article.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {article.excerpt}
                  </p>
                </Link>
              ))}
            </div>

            <div className="mt-8 rounded-2xl border border-border bg-muted/40 p-5">
              <p className="font-semibold">Still stuck?</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We reply within 24–48 hours on business days.
              </p>
              <Link
                href="/contactus"
                className="mt-3 inline-block text-sm font-medium underline underline-offset-4"
              >
                Contact support
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
