"use client";

/**
 * Tabs whose active panel lives in the URL as `?tab=<value>`.
 *
 * The dashboard IA consolidation collapsed a number of sidebar entries into
 * tabs on a single page (Members absorbed Learners/Experts/Invitations,
 * Operations absorbed the four read-only tables, Settings absorbed SSO and the
 * integrations). Those retired routes redirect to `?tab=` targets, so the tab
 * state has to be addressable — a plain `defaultValue` would drop the user on
 * the first panel regardless of where they came from.
 *
 * Uses `router.replace` with `scroll: false`: switching a tab is a lateral
 * move, not navigation, so it shouldn't stack history entries or jump the
 * viewport. The browser back button still leaves the page rather than walking
 * back through every tab the user glanced at.
 *
 * Tabs are filtered by `show` so a caller can gate individual panels off the
 * same permission matrix that gates the sidebar — a hidden tab must not render
 * a trigger that 403s when clicked.
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface UrlTab {
  value: string;
  label: string;
  content: React.ReactNode;
  /** Omit or pass true to show. False removes the trigger and the panel. */
  show?: boolean;
}

export function UrlTabs({
  tabs,
  paramName = "tab",
  className,
}: {
  tabs: UrlTab[];
  paramName?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const visible = tabs.filter((t) => t.show !== false);
  const requested = searchParams?.get(paramName);
  // Fall back to the first visible tab when the param is absent or names a tab
  // this user can't see — a stale bookmark shouldn't render an empty page.
  const active =
    visible.find((t) => t.value === requested)?.value ?? visible[0]?.value;

  const onValueChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set(paramName, value);
      // Panels that paginate all read the same `?page=`. Without this, moving
      // to page 3 of Waitlist and then clicking Trials would open Trials on
      // page 3 — or on an empty page, if it has fewer.
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [paramName, pathname, router, searchParams],
  );

  if (!active) return null;

  return (
    <Tabs value={active} onValueChange={onValueChange} className={className}>
      <TabsList>
        {visible.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {visible.map((t) => (
        <TabsContent key={t.value} value={t.value} className="space-y-6">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
