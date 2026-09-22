import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { ArticleActions } from "../../_components/ArticleActions";
import {
  articleUrl,
  articlesForCategory,
  CONTENT_ISO_DATE,
  getArticle,
  getCategory,
  relatedArticles,
} from "../../_data/support-content";

export const revalidate = 3600;

// No generateStaticParams — same build-OOM rationale as [category]/page.tsx:
// on-demand ISR instead of build-time prerender for all 41 articles.

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ category: string; slug: string }>;
}): Promise<Metadata> {
  const { category, slug } = await params;
  const article = getArticle(category, slug);
  if (!article) return { title: "Article not found" };
  return {
    title: `${article.title} | Familiarise Help Center`,
    description: article.excerpt,
  };
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export default async function SupportArticlePage({
  params,
}: {
  readonly params: Promise<{ category: string; slug: string }>;
}) {
  const { category, slug } = await params;
  const article = getArticle(category, slug);
  if (!article) notFound();
  const categoryData = getCategory(category);
  if (!categoryData) notFound();
  const related = relatedArticles(article);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.excerpt,
    dateModified: CONTENT_ISO_DATE,
  };
  // Carry the article's escalation category into Contact us so the form
  // arrives pre-categorised (ContactForm validates it before applying).
  const contactHref = `/contactus?category=${encodeURIComponent(article.contactCategory)}`;

  return (
    <section className="w-full">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
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
            <li>
              <Link
                href={`/support/${category}`}
                className="hover:text-foreground"
              >
                {categoryData.title}
              </Link>
            </li>
            <li aria-hidden>
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li className="max-w-[40ch] truncate text-foreground">
              {article.title}
            </li>
          </ol>
        </nav>

        <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
          <article className="min-w-0">
            <h1 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight">
              {article.title}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Updated {article.updated}
            </p>

            <div className="prose prose-slate mt-8 max-w-none">
              {article.sections.map((section) => (
                <section key={section.heading} id={slugify(section.heading)}>
                  <h2>{section.heading}</h2>
                  {section.paragraphs.map((p) => (
                    <p key={p.slice(0, 48)}>{p}</p>
                  ))}
                  {section.list && (
                    <ul>
                      {section.list.map((item) => (
                        <li key={item.slice(0, 48)}>{item}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>

            {related.length > 0 && (
              <div className="mt-10">
                <h2 className="text-fluid-xl font-semibold tracking-tight">
                  Related articles
                </h2>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                  {related.map((r) => (
                    <li key={`${r.category}/${r.slug}`}>
                      <Link
                        href={articleUrl(r)}
                        className="block rounded-2xl border border-border bg-card p-4 text-sm transition-all hover:-translate-y-0.5 hover:shadow-elevation-1"
                      >
                        <span className="font-medium">{r.title}</span>
                        <span className="mt-1 block text-muted-foreground">
                          {getCategory(r.category)?.title}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-10 rounded-2xl border border-border bg-muted/40 p-5">
              <p className="font-semibold">Still need help?</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Contact us — we reply within 24–48 hours on business days. For
                money questions, the{" "}
                <Link href="/refund" className="underline underline-offset-2">
                  Cancellation &amp; Refund Policy
                </Link>{" "}
                governs.
              </p>
              <Link
                href={contactHref}
                className="mt-3 inline-block text-sm font-medium underline underline-offset-4"
              >
                Contact support
              </Link>
            </div>
          </article>

          <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-sm font-semibold">On this page</p>
              <ul className="mt-3 space-y-1.5">
                {article.sections.map((section) => (
                  <li key={section.heading}>
                    <a
                      href={`#${slugify(section.heading)}`}
                      className="block text-sm text-muted-foreground hover:text-foreground"
                    >
                      {section.heading}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <ArticleActions article={article} />
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-sm font-semibold">
                More in {categoryData.title}
              </p>
              <ul className="mt-3 space-y-1.5">
                {articlesForCategory(category)
                  .filter((a) => a.slug !== article.slug)
                  .slice(0, 5)
                  .map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={articleUrl(a)}
                        className="block text-sm text-muted-foreground hover:text-foreground"
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
