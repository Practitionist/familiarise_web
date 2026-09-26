"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/utils/tailwind";

/**
 * #1771 K-2 — the Money hub's tab strip. Each tab is its own URL, so back,
 * forward and deep links work and the sidebar keeps a single Money entry.
 */
export function MoneyHubNav({
  basePath,
  tabs,
}: Readonly<{
  basePath: string;
  tabs: { key: string; label: string }[];
}>) {
  const pathname = usePathname();
  return (
    <nav aria-label="Money sections" className="border-b border-border/60">
      <ul className="flex gap-1 overflow-x-auto px-4 py-2 md:px-6 lg:px-8">
        {tabs.map((tab) => {
          const href = `${basePath}/${tab.key}`;
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={tab.key} className="shrink-0">
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "block rounded-full px-3 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-zinc-900 font-medium text-white"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
