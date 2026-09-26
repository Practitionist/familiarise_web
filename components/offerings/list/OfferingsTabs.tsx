"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/utils/tailwind";

/**
 * #1527 §13b — Offerings · Collaborations. Link tabs rather than panels: each
 * is its own URL (`offerings`, `offerings/collaborations`), so the old
 * `collaborations` route 308s straight to a tab.
 */
export function OfferingsTabs({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const pathname = usePathname();
  const base = `/dashboard/consultant/${consultantId}/offerings`;
  const tabs = [
    { href: base, label: "Offerings" },
    { href: `${base}/collaborations`, label: "Collaborations" },
  ];
  return (
    <nav
      aria-label="Offerings sections"
      className="mb-6 inline-flex rounded-lg bg-muted p-1"
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
