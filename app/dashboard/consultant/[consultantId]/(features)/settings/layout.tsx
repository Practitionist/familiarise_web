"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { cn } from "@/utils/tailwind";
import {
  settingsSectionForPath,
  settingsSectionGroups,
  settingsSectionHref,
} from "./settings";

/**
 * The Settings hub (#1785 L-2): one header, a grouped left nav from `md` up
 * and a scrollable segmented strip below it, and the section route as the
 * body. Every section is its own URL, so back/forward and deep links work and
 * the sidebar keeps a single Settings entry.
 */
export default function SettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { consultantId } = useParams<{ consultantId: string }>();
  const pathname = usePathname();
  const basePath = `/dashboard/consultant/${consultantId}`;
  const active = settingsSectionForPath(basePath, pathname);
  const groups = settingsSectionGroups();

  return (
    <>
      <DashboardHeader
        title="Settings"
        subtitle={active?.description ?? "Your profile, payouts and account"}
      />
      <div className="flex flex-col md:flex-row">
        <nav
          aria-label="Settings sections"
          className="border-b border-border/60 md:w-56 md:shrink-0 md:border-b-0 md:border-r md:py-6 md:pl-6 md:pr-2 lg:pl-8"
        >
          {/* Mobile: one flat strip, scrollable, group titles dropped. */}
          <ul className="flex gap-1 overflow-x-auto px-4 py-2 md:hidden">
            {groups
              .flatMap((g) => g.sections)
              .map((section) => {
                const isActive = active?.key === section.key;
                return (
                  <li key={section.key} className="shrink-0">
                    <Link
                      href={settingsSectionHref(basePath, section)}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "block rounded-full px-3 py-1.5 text-sm transition-colors",
                        isActive
                          ? "bg-zinc-900 font-medium text-white"
                          : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                      )}
                    >
                      {section.label}
                    </Link>
                  </li>
                );
              })}
          </ul>
          {/* md+: titled groups, one link per section. */}
          <div className="hidden space-y-5 md:block">
            {groups.map((group) => (
              <div key={group.title}>
                <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  {group.title}
                </p>
                <ul className="space-y-0.5">
                  {group.sections.map((section) => {
                    const isActive = active?.key === section.key;
                    return (
                      <li key={section.key}>
                        <Link
                          href={settingsSectionHref(basePath, section)}
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            "block rounded-lg px-2 py-1.5 text-sm transition-colors",
                            isActive
                              ? "bg-zinc-100 font-medium text-zinc-900"
                              : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900",
                          )}
                        >
                          {section.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </>
  );
}
