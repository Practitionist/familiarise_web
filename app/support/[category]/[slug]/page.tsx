import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Calendar, CheckCircle2, ChevronRight } from "lucide-react";

import { ArticleActions } from "../../_components/ArticleActions";
import { SupportArticleToc } from "../../_components/SupportArticleToc";
import {
  SupportSidebar,
  SupportSidebarMobile,
} from "../../_components/SupportSidebar";
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
  const tocSections = article.sections.map((section) => ({
    id: slugify(section.heading),
    heading: section.heading,
  }));

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

        <SupportSidebarMobile />
        <div className="flex gap-10">
          <div className="hidden lg:block">
            <SupportSidebar />
          </div>
          <article className="min-w-0 flex-1">
            {/* Article Header Card */}
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-elevation-1">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-foreground">
                  {categoryData.title}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" aria-hidden />
                  <span>Updated {article.updated}</span>
                </span>
              </div>
              <h1 className="mt-3 text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight text-foreground">
                {article.title}
              </h1>
              {article.excerpt && (
                <p className="mt-2.5 text-sm md:text-base leading-relaxed text-muted-foreground">
                  {article.excerpt}
                </p>
              )}

              {/* Mobile Jump-to-Section Pill Strip */}
              {tocSections.length > 1 && (
                <div className="mt-5 border-t border-border pt-4 lg:hidden">
                  <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Jump to section
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {tocSections.map((sec, idx) => (
                      <a
                        key={sec.id}
                        href={`#${sec.id}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        <span className="font-mono text-[10px] font-semibold text-muted-foreground">
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        <span>{sec.heading}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Structured Editorial Section Cards */}
            <div className="mt-6 space-y-6">
              {article.sections.map((section, index) => {
                const sectionId = slugify(section.heading);
                const numberBadge = String(index + 1).padStart(2, "0");
                const bullets = section.list ?? [];

                return (
                  <section
                    key={section.heading}
                    id={sectionId}
                    className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-elevation-1 scroll-mt-28"
                  >
                    <div className="flex items-start gap-3.5 border-b border-border pb-4">
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-950 font-mono text-xs font-semibold text-white dark:bg-white dark:text-zinc-950">
                        {numberBadge}
                      </span>
                      <h2 className="text-lg md:text-xl font-semibold tracking-tight text-foreground pt-0.5">
                        {section.heading}
                      </h2>
                    </div>

                    <div className="mt-4 space-y-3.5 text-sm md:text-[15px] leading-relaxed text-muted-foreground">
                      {section.paragraphs.map((p) => (
                        <p key={p.slice(0, 48)}>{p}</p>
                      ))}
                    </div>

                    {bullets.length > 0 && (
                      <div className="mt-5 rounded-xl border border-border/70 bg-muted/35 p-4 md:p-5">
                        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-foreground/80">
                          Key takeaways &amp; steps
                        </p>
                        <ul className="space-y-2.5">
                          {bullets.map((item) => (
                            <li
                              key={item.slice(0, 48)}
                              className="flex items-start gap-2.5 text-sm leading-relaxed text-foreground/90"
                            >
                              <CheckCircle2
                                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                                aria-hidden
                              />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                );
              })}
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

          <aside className="hidden w-64 shrink-0 space-y-4 lg:block xl:w-72">
            <div className="sticky top-24 space-y-4">
              <SupportArticleToc
                sections={tocSections}
                contactHref={contactHref}
              />
              <div className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1">
                <ArticleActions article={article} />
              </div>
              <div className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1">
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
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
