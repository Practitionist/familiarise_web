"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import type { LibraryTab } from "@/lib/dashboard/library-tabs";
import { cn } from "@/utils/tailwind";

const TAB_LABEL: Record<LibraryTab, string> = {
  purchases: "Purchases",
  recordings: "Session recordings",
  documents: "Session documents",
};

/**
 * The Library's tab links. The org scope pick is written with `replaceUrl`, so
 * it is read from the live URL here, never from the server's initial params.
 */
export function LibraryTabNav({
  title,
  basePath,
  tabs,
  active,
  carryScope,
}: Readonly<{
  title: string;
  basePath: string;
  tabs: readonly LibraryTab[];
  active: LibraryTab;
  /** The org Library keeps its Mine · Everyone pick across tabs. */
  carryScope: boolean;
}>) {
  const searchParams = useSearchParams();
  const requested = searchParams?.get("scope");
  const scope =
    carryScope && (requested === "mine" || requested === "everyone")
      ? requested
      : null;
  const hrefFor = (tab: LibraryTab) => {
    const params = new URLSearchParams({ tab });
    if (scope) params.set("scope", scope);
    return `${basePath}?${params.toString()}`;
  };
  return (
    <nav
      aria-label={`${title} sections`}
      className="-mx-1 overflow-x-auto px-1"
    >
      <ul className="flex min-w-max items-center gap-6 border-b border-border">
        {tabs.map((tab) => (
          <li key={tab} className="shrink-0">
            <Link
              href={hrefFor(tab)}
              aria-current={tab === active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex items-center whitespace-nowrap border-b-2 px-0.5 py-3 text-sm font-medium transition-colors focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                tab === active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {TAB_LABEL[tab]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
