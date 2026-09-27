"use client";

/**
 * Mine · Everyone · Unscheduled for the org Appointments page (#1527 §7.3).
 *
 * Server-driven tabs: each tab is a different server read, so switching
 * replaces the URL (`?tab=`) and lets the page re-render, rather than the
 * client-only UrlTabs. Tabs the viewer can't use are never offered; with only
 * "Mine" left, nothing renders.
 */

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";

export type AppointmentTab = "mine" | "everyone" | "unscheduled";

const LABEL: Record<AppointmentTab, string> = {
  mine: "Mine",
  everyone: "Everyone",
  unscheduled: "Unscheduled",
};

export function AppointmentTabs({
  active,
  available,
}: Readonly<{ active: AppointmentTab; available: AppointmentTab[] }>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // #1527 QA wave 3 — the click shows at once; the server's `active` wins as
  // soon as the navigation lands (it no longer matches `from`).
  const [picked, setPicked] = useState<{
    tab: AppointmentTab;
    from: AppointmentTab;
  } | null>(null);
  const shown = picked?.from === active ? picked.tab : active;

  if (available.length < 2) return null;

  const select = (next: AppointmentTab) => {
    if (next === shown) return;
    setPicked({ tab: next, from: active });
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", next);
    params.delete("scope");
    // The tabs paginate independently.
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div
      role="group"
      aria-label="Which appointments"
      aria-busy={shown !== active}
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {available.map((tab) => (
        <Button
          key={tab}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={shown === tab}
          onClick={() => select(tab)}
          className={cn(
            "h-7 px-3 text-sm",
            shown === tab
              ? "bg-background shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LABEL[tab]}
        </Button>
      ))}
    </div>
  );
}
