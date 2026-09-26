"use client";

/**
 * Mine · Everyone · Unscheduled for the org Appointments page (#1527 §7.3).
 *
 * Server-driven tabs: each tab is a different server read, so switching
 * replaces the URL (`?tab=`) and lets the page re-render, rather than the
 * client-only UrlTabs. Tabs the viewer can't use are never offered; with only
 * "Mine" left, nothing renders.
 */

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

  if (available.length < 2) return null;

  const select = (next: AppointmentTab) => {
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
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {available.map((tab) => (
        <Button
          key={tab}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={active === tab}
          onClick={() => select(tab)}
          className={cn(
            "h-7 px-3 text-sm",
            active === tab
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
