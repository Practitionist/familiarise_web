"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Calendar,
  FileText,
  HelpCircle,
  type LucideIcon,
  Mail,
  MessageSquare,
  RefreshCw,
  Shield,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { COMPANY_INFO, getMailtoLink } from "./constants";

export type PolicyKey = "terms" | "privacy" | "refund";

export interface LegalHighlight {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly title: string;
  readonly description: string;
}

export interface LegalSection {
  readonly id?: string;
  readonly title: string;
  readonly content: ReactNode;
}

export interface LegalClosingNotice {
  readonly title: string;
  readonly description: string;
}

export interface LegalEditorialLayoutProps {
  readonly activePolicy: PolicyKey;
  readonly eyebrow: string;
  readonly eyebrowIcon: LucideIcon;
  readonly lastUpdated: string;
  readonly titlePrefix: string;
  readonly titleHighlight: string;
  readonly description: string;
  readonly highlights: readonly LegalHighlight[];
  readonly sections: readonly LegalSection[];
  readonly closingNotice?: LegalClosingNotice;
}

const POLICY_TABS: readonly {
  readonly key: PolicyKey;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
}[] = [
  {
    key: "terms",
    label: "Terms of Service",
    href: "/terms",
    icon: FileText,
  },
  {
    key: "privacy",
    label: "Privacy Policy",
    href: "/privacy",
    icon: Shield,
  },
  {
    key: "refund",
    label: "Refund Policy",
    href: "/refund",
    icon: RefreshCw,
  },
];

export function LegalEditorialLayout({
  activePolicy,
  eyebrow,
  eyebrowIcon: EyebrowIcon,
  lastUpdated,
  titlePrefix,
  titleHighlight,
  description,
  highlights,
  sections,
  closingNotice,
}: Readonly<LegalEditorialLayoutProps>) {
  const sectionItems = useMemo(
    () =>
      sections.map((section, index) => ({
        ...section,
        resolvedId: section.id ?? `section-${index + 1}`,
        numberBadge: String(index + 1).padStart(2, "0"),
      })),
    [sections],
  );

  const [activeSectionId, setActiveSectionId] = useState<string>(
    () => sectionItems[0]?.resolvedId ?? "section-1",
  );
  const tocNavRef = useRef<HTMLElement | null>(null);
  const clickLockUntilRef = useRef<number>(0);

  useEffect(() => {
    if (sectionItems.length === 0) return;

    const sectionIds = sectionItems.map((item) => item.resolvedId);
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const computeActiveFromScroll = () => {
      if (Date.now() < clickLockUntilRef.current) return;

      const scrollOffset = 160;
      let currentId = sectionIds[0];

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= scrollOffset) {
          currentId = el.id;
        } else {
          break;
        }
      }

      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 32
      ) {
        currentId = elements[elements.length - 1]?.id ?? currentId;
      }

      setActiveSectionId((prev) => (prev === currentId ? prev : currentId));
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < clickLockUntilRef.current) return;
        const intersecting = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (intersecting.length > 0) {
          const targetId = intersecting[0].target.id;
          if (targetId) {
            setActiveSectionId((prev) => (prev === targetId ? prev : targetId));
            return;
          }
        }
        computeActiveFromScroll();
      },
      {
        rootMargin: "-120px 0px -65% 0px",
        threshold: [0, 0.1, 0.5, 1],
      },
    );

    for (const el of elements) {
      observer.observe(el);
    }

    const handleHashChange = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (hashId && sectionIds.includes(hashId)) {
        clickLockUntilRef.current = Date.now() + 700;
        setActiveSectionId(hashId);
      }
    };

    if (window.location.hash) {
      handleHashChange();
    } else {
      computeActiveFromScroll();
    }

    window.addEventListener("scroll", computeActiveFromScroll, {
      passive: true,
    });
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", computeActiveFromScroll);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [sectionItems]);

  useEffect(() => {
    const nav = tocNavRef.current;
    if (!nav || !activeSectionId) return;
    const activeLink = nav.querySelector<HTMLElement>(
      `[data-toc-id="${activeSectionId}"]`,
    );
    if (!activeLink) return;

    const navRect = nav.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    if (linkRect.top < navRect.top + 8 || linkRect.bottom > navRect.bottom - 8) {
      const targetScrollTop =
        linkRect.top -
        navRect.top +
        nav.scrollTop -
        nav.clientHeight / 2 +
        linkRect.height / 2;
      nav.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "smooth",
      });
    }
  }, [activeSectionId]);

  return (
    <main className="min-h-screen w-full bg-background">
      {/* Full-Bleed Dark Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white pt-32 pb-20 md:pb-24">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[760px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),transparent)]"
        />

        <div className="container relative z-10 mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mb-6 flex flex-wrap items-center justify-center gap-2.5">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/80 px-4 py-1.5 text-sm text-zinc-300 backdrop-blur-sm">
              <EyebrowIcon
                className="h-4 w-4 text-zinc-300"
                aria-hidden="true"
              />
              <span>{eyebrow}</span>
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/50 px-3.5 py-1.5 text-xs font-medium text-zinc-400">
              <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Last Updated: {lastUpdated}</span>
            </div>
          </div>

          <h1 className="text-fluid-4xl md:text-fluid-5xl mb-6 font-bold tracking-tight">
            <span>{titlePrefix} </span>
            <span className="silver-text">{titleHighlight}</span>
          </h1>

          <p className="mx-auto max-w-2xl text-lg leading-relaxed text-zinc-400 md:text-xl">
            {description}
          </p>

          {/* Cross-Policy Switcher Pills */}
          <nav
            aria-label="Legal policies"
            className="mt-10 inline-flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-zinc-800/90 bg-zinc-900/70 p-1.5 backdrop-blur-sm"
          >
            {POLICY_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.key === activePolicy;
              return (
                <Link
                  key={tab.key}
                  href={tab.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-medium transition-all ${
                    isActive
                      ? "bg-white text-zinc-950 shadow-sm"
                      : "text-zinc-400 hover:bg-zinc-800/70 hover:text-white"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{tab.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </section>

      {/* "At a Glance" Summary Bento Row */}
      <section className="border-b border-border bg-muted/30 py-12 md:py-16">
        <div className="container mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8">
          <div className="mb-8 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Key Takeaways
              </p>
              <h2 className="text-fluid-2xl mt-1 font-bold tracking-tight text-foreground">
                At a glance
              </h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Summary for convenience — full binding terms follow below.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {highlights.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.title}
                  className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 flex flex-col justify-between"
                >
                  <div>
                    <div className="mb-4 flex items-center justify-between gap-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <Badge variant="secondary" className="text-[11px]">
                        {item.label}
                      </Badge>
                    </div>
                    <h3 className="mb-2 text-base font-semibold tracking-tight text-foreground">
                      {item.title}
                    </h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 2-Column Editorial Body */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[260px_minmax(0,1fr)]">
            {/* Left Sticky Sidebar */}
            <aside className="space-y-6 lg:sticky lg:top-28 lg:self-start">
              <div className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1">
                <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  On this page
                </p>
                <nav
                  ref={tocNavRef}
                  aria-label="Table of contents"
                  className="max-h-[60vh] overflow-y-auto pr-1"
                >
                  <ol className="space-y-1">
                    {sectionItems.map((section) => {
                      const isActive = activeSectionId === section.resolvedId;
                      return (
                        <li key={section.resolvedId}>
                          <a
                            href={`#${section.resolvedId}`}
                            data-toc-id={section.resolvedId}
                            aria-current={isActive ? "location" : undefined}
                            onClick={() => {
                              clickLockUntilRef.current = Date.now() + 700;
                              setActiveSectionId(section.resolvedId);
                            }}
                            className={`group flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                              isActive
                                ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-medium shadow-2xs"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            }`}
                          >
                            <span
                              className={`inline-flex h-4 min-w-5 shrink-0 items-center justify-center rounded px-1 font-mono text-[11px] font-semibold transition-colors ${
                                isActive
                                  ? "bg-white/20 text-white dark:bg-zinc-900/15 dark:text-zinc-900"
                                  : "text-muted-foreground/70 group-hover:text-foreground"
                              }`}
                            >
                              {section.numberBadge}
                            </span>
                            <span className="leading-snug">{section.title}</span>
                          </a>
                        </li>
                      );
                    })}
                  </ol>
                </nav>
              </div>

              {/* Compact Contact Legal & Support Card */}
              <div className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Questions?
                </p>
                <h3 className="text-sm font-semibold text-foreground">
                  Contact Legal &amp; Support
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Need clarification on a clause, billing rule, or data request?
                  Our team is ready to help.
                </p>
                <div className="space-y-2 pt-1 text-xs">
                  <a
                    href={getMailtoLink()}
                    className="flex items-center gap-2 font-medium text-foreground hover:underline"
                  >
                    <Mail
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>{COMPANY_INFO.email}</span>
                  </a>
                  <Link
                    href="/contactus"
                    className="flex items-center gap-2 font-medium text-foreground hover:underline"
                  >
                    <MessageSquare
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>Contact Form</span>
                  </Link>
                  <Link
                    href="/support"
                    className="flex items-center gap-2 font-medium text-foreground hover:underline"
                  >
                    <HelpCircle
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>Help Center</span>
                  </Link>
                </div>
              </div>
            </aside>

            {/* Right Column: Editorial Section Cards */}
            <div className="space-y-6">
              {sectionItems.map((section) => {
                return (
                  <article
                    key={section.resolvedId}
                    id={section.resolvedId}
                    className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-elevation-1 space-y-4 scroll-mt-28"
                  >
                    <div className="flex items-start gap-3.5 border-b border-border pb-4">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-950 font-mono text-xs font-semibold text-white dark:bg-white dark:text-zinc-950">
                        {section.numberBadge}
                      </span>
                      <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground pt-0.5">
                        {section.title}
                      </h2>
                    </div>
                    <div className="prose prose-slate dark:prose-invert max-w-none prose-headings:tracking-tight prose-p:leading-relaxed prose-li:leading-relaxed">
                      {section.content}
                    </div>
                  </article>
                );
              })}

              {closingNotice && (
                <div className="rounded-2xl border border-border bg-secondary p-6 md:p-8 shadow-elevation-1">
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    {closingNotice.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {closingNotice.description}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Dark Closing CTA Band */}
      <section className="relative overflow-hidden bg-zinc-950 text-white py-16 border-t border-zinc-800/80">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div className="container relative z-10 mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div className="max-w-xl">
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-2">
                Still have questions?
              </p>
              <h2 className="text-fluid-2xl md:text-fluid-3xl font-bold tracking-tight text-white mb-2">
                We&apos;re here to help you navigate {COMPANY_INFO.name}
              </h2>
              <p className="text-sm md:text-base text-zinc-400 leading-relaxed">
                Reach out to our support and legal team or browse step-by-step
                guides in the Help Center.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <Button
                asChild
                size="lg"
                className="h-11 rounded-xl bg-white px-6 text-zinc-900 hover:bg-zinc-100"
              >
                <Link href="/contactus">
                  <span>Contact Us</span>
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-11 rounded-xl border-zinc-700 bg-transparent px-6 text-white hover:bg-zinc-900 hover:text-white"
              >
                <Link href="/support">Visit Help Center</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
