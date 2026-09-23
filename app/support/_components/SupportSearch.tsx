"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  articleUrl,
  getCategory,
  searchSupport,
} from "../_data/support-content";

const POPULAR = [
  "refund status",
  "reschedule session",
  "payment failed",
  "join video call",
  "SSO sign in",
  "payout",
  "GST invoice",
];

/**
 * Hero search for `/support`. In-memory substring ranking over the public
 * corpus (same model as the dashboard HelpPanel) with the query synced to
 * `?q=` so results are shareable. Deliberately NOT in the navbar — the
 * support corpus is scoped, and the global nav stays auth/marketing focused.
 */
export function SupportSearch() {
  const pathname = usePathname();
  const params = useSearchParams();
  const initial = params.get("q") ?? "";
  const [value, setValue] = useState(initial);

  const results = useMemo(() => searchSupport(value), [value]);
  const trimmed = value.trim();
  const showResults = trimmed.length > 0;

  function sync(next: string) {
    setValue(next);
    // History API, not router.replace: results are pure client state, so a
    // Next navigation per keystroke would pointlessly refetch the page. The
    // URL still updates, keeping `?q=` shareable.
    const sp = new URLSearchParams(params.toString());
    if (next.trim()) sp.set("q", next.trim());
    else sp.delete("q");
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="relative">
        <Search
          className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={value}
          onChange={(e) => sync(e.target.value)}
          placeholder="Search for answers…"
          aria-label="Search support articles"
          className="h-14 rounded-full pl-12 pr-5 text-base shadow-elevation-1"
        />
      </div>

      {!showResults && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <span className="text-sm text-muted-foreground">Popular:</span>
          {POPULAR.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => sync(term)}
              className="rounded-full border border-border bg-card px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {term}
            </button>
          ))}
        </div>
      )}

      {showResults && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-card text-left shadow-elevation-1">
          {results.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">
              No articles match “{trimmed}”. Try fewer words, or{" "}
              <Link href="/contactus" className="underline underline-offset-2">
                contact support
              </Link>
              .
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.slice(0, 8).map((article) => (
                <li key={`${article.category}/${article.slug}`}>
                  <Link
                    href={articleUrl(article)}
                    className="group flex items-start justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-muted/60"
                  >
                    <span>
                      <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {getCategory(article.category)?.title}
                      </span>
                      <span className="block font-medium leading-snug">
                        {article.title}
                      </span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">
                        {article.excerpt}
                      </span>
                    </span>
                    <ArrowRight
                      className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
