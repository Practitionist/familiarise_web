"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/utils/tailwind";

/**
 * PageScaffold — page-scaffold primitives shared by every dashboard role
 * (org, staff, admin, consultant, consultee): the page header, the content
 * flow, and a responsive KPI grid.
 *
 * Formerly DashboardShell.tsx; renamed when the legacy `DashboardShell`
 * layout wrapper (fixed sidebar + mobile drawer) died with the
 * shared-shell redesign — all dashboards now compose
 * `PersonalDashboardShell` / the org layout's CollapsibleSidebar chrome
 * instead, and only these scaffold primitives remain.
 */

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Legacy name for `description`. */
  subtitle?: ReactNode;
  /** Right-aligned at sm+, stacked full-width under the title on mobile. */
  actions?: ReactNode;
  /** A small link above the title, for detail pages. */
  back?: { href: string; label: string };
  /** A line of facts under the description (status badge, dates, ids). */
  meta?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
  className?: string;
}

/**
 * The page title block (#1527 §15). It used to be a full-bleed blurred band
 * with its own gutter inside shells that already pad, so the title sat inset
 * from the content below it. The shell owns the gutter now; this is only type
 * and spacing.
 */
export function PageHeader({
  title,
  description,
  subtitle,
  actions,
  back,
  meta,
  breadcrumbs,
  className,
}: Readonly<PageHeaderProps>) {
  const desc = description ?? subtitle;
  return (
    <header className={cn("mb-6", className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {breadcrumbs.map((crumb, index) => (
              <li key={crumb.label} className="flex items-center gap-2">
                {index > 0 && <span aria-hidden>/</span>}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="transition-colors hover:text-foreground"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {back && (
        <Link
          href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-[22px]">
            {title}
          </h1>
          {desc && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {desc}
            </p>
          )}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:shrink-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

/** The name 68 pages already import; same component as `PageHeader`. */
export const DashboardHeader = PageHeader;

interface PanelHeaderProps {
  description?: string;
  actions?: ReactNode;
}

/**
 * Header for a tab panel, as opposed to a page.
 *
 * When the IA consolidation folded sidebar entries into tabs, the panels kept
 * their old `DashboardHeader` — which renders an `h1`. Inside a tab that reads
 * as a second page title directly under the tab you just clicked. This drops
 * the heading and keeps only what the panel still needs: a line of context and
 * its own actions.
 */
export function PanelHeader({ description, actions }: PanelHeaderProps) {
  if (!description && !actions) return null;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3 sm:shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}

interface DashboardContentProps {
  children: ReactNode;
  className?: string;
  fullHeight?: boolean;
}

export function DashboardContent({
  children,
  className,
  fullHeight = false,
}: DashboardContentProps) {
  return (
    <div
      // #1527: no own padding; the shell owns the gutter.
      className={cn(
        "space-y-6",
        fullHeight && "flex-1 flex flex-col overflow-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface DashboardGridProps {
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}

export function DashboardGrid({
  children,
  columns = 3,
  className,
}: DashboardGridProps) {
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  };

  return (
    <div className={cn("grid gap-4 lg:gap-6", gridCols[columns], className)}>
      {children}
    </div>
  );
}
