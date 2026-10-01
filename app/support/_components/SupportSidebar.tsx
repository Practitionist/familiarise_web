"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown, ChevronRight, LifeBuoy } from "lucide-react";

import { cn } from "@/utils/tailwind";
import {
  articlesForCategory,
  supportCategories,
} from "../_data/support-content";
import { SUPPORT_ICONS } from "./CategoryGrid";

/**
 * Claude-style left sidebar: one row per collection with an expand chevron;
 * expanding reveals that collection's articles. The active collection (from
 * the URL) starts expanded. Desktop gets a sticky column; mobile gets a
 * "Browse topics" disclosure above the content.
 */
function useExpanded(): [Set<string>, (slug: string) => void] {
  const pathname = usePathname();
  const active = supportCategories.find((c) =>
    pathname.startsWith(`/support/${c.slug}`),
  )?.slug;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(active ? [active] : [supportCategories[0]?.slug ?? ""]),
  );
  function toggle(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }
  return [expanded, toggle];
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [expanded, toggle] = useExpanded();

  return (
    <ul className="space-y-0.5">
      {supportCategories.map((category) => {
        const Icon = SUPPORT_ICONS[category.icon] ?? LifeBuoy;
        const isActive = pathname.startsWith(`/support/${category.slug}`);
        const isOpen = expanded.has(category.slug);
        const articles = articlesForCategory(category.slug);
        return (
          <li key={category.slug}>
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-2",
                isActive ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <Icon
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <Link
                href={`/support/${category.slug}`}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  isActive ? "font-semibold" : "font-medium",
                )}
              >
                {category.title}
              </Link>
              <button
                type="button"
                onClick={() => toggle(category.slug)}
                aria-expanded={isOpen}
                aria-label={
                  isOpen
                    ? `Collapse ${category.title}`
                    : `Expand ${category.title}`
                }
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden />
                )}
              </button>
            </div>
            {isOpen && (
              <ul className="ml-6 space-y-0.5 border-l border-border py-1 pl-3">
                {articles.map((article) => {
                  const href = `/support/${article.category}/${article.slug}`;
                  const isCurrent = pathname === href;
                  return (
                    <li key={article.slug}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        aria-current={isCurrent ? "page" : undefined}
                        className={cn(
                          "block rounded-md px-2 py-1.5 text-sm leading-snug",
                          isCurrent
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                      >
                        {article.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SupportSidebar() {
  return (
    <nav
      aria-label="Help topics"
      className="hidden w-64 shrink-0 lg:block xl:w-72"
    >
      <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
        <SidebarBody />
      </div>
    </nav>
  );
}

export function SupportSidebarMobile() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mb-6 rounded-2xl border border-border bg-card lg:hidden"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer list-none px-5 py-3.5 text-sm font-semibold">
        {open ? "Hide topics" : "Browse topics"}
      </summary>
      <div className="max-h-96 overflow-y-auto border-t border-border px-3 py-3">
        <SidebarBody onNavigate={() => setOpen(false)} />
      </div>
    </details>
  );
}
