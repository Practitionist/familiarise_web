"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight, LifeBuoy } from "lucide-react";
import { useScrollSpy } from "@/hooks/use-scroll-spy";

export interface SupportTocSection {
  readonly id: string;
  readonly heading: string;
}

export interface SupportArticleTocProps {
  readonly sections: readonly SupportTocSection[];
  readonly contactHref?: string;
}

export function SupportArticleToc({
  sections,
  contactHref = "/contactus",
}: Readonly<SupportArticleTocProps>) {
  const sectionItems = useMemo(
    () =>
      sections.map((section, index) => ({
        ...section,
        numberBadge: String(index + 1).padStart(2, "0"),
      })),
    [sections],
  );
  const sectionIds = useMemo(
    () => sectionItems.map((item) => item.id),
    [sectionItems],
  );
  const { activeSectionId, tocNavRef, selectSection } =
    useScrollSpy(sectionIds);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          On this page
        </p>
        <nav
          ref={tocNavRef}
          aria-label="On this page"
          className="max-h-[52vh] overflow-y-auto pr-1"
        >
          <ol className="space-y-1">
            {sectionItems.map((section) => {
              const isActive = activeSectionId === section.id;
              return (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    data-toc-id={section.id}
                    aria-current={isActive ? "location" : undefined}
                    onClick={() => selectSection(section.id)}
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
                    <span className="leading-snug">{section.heading}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      {/* Compact Need More Help Card */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1 space-y-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
            <LifeBuoy className="h-3.5 w-3.5 text-foreground" aria-hidden />
          </div>
          <p className="text-xs font-semibold text-foreground">
            Need more help?
          </p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Can&apos;t find what you&apos;re looking for? Reach our support team
          directly.
        </p>
        <Link
          href={contactHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-4 hover:no-underline"
        >
          <span>Contact support</span>
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
