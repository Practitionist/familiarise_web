"use client";

import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";

// The inline field-error pattern (#1527 §14): `invalidProps` puts
// `aria-invalid` + `aria-describedby` on the input, `FieldError` renders the
// message under it with the matching id.
export { FieldError, invalidProps } from "@/components/ui/field-error";

export interface SettingsNavSection {
  key: string;
  label: string;
  href: string;
  /** Replaces the page description while this section is open. */
  description?: string;
  /** `false` hides the section, e.g. when a permission is missing. */
  show?: boolean;
  icon?: LucideIcon;
}

export interface SettingsNavGroup {
  title: string;
  sections: SettingsNavSection[];
}

export interface SettingsLayoutProps {
  title: string;
  description?: string;
  groups: SettingsNavGroup[];
  /** The hub root; with no section open it shows the section list. */
  basePath: string;
  /** Where the mobile "Settings" back link goes; defaults to `basePath`. */
  listHref?: string;
  children: ReactNode;
}

function isActive(section: SettingsNavSection, pathname: string) {
  return pathname === section.href || pathname.startsWith(`${section.href}/`);
}

/** The mobile hub list: every section as a row, grouped (list → detail). */
function SectionList({ groups }: Readonly<{ groups: SettingsNavGroup[] }>) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.title}>
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {group.title}
          </h2>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {group.sections.map((section) => {
              const Icon = section.icon;
              return (
                <li key={section.key}>
                  <Link
                    href={section.href}
                    className="flex min-h-12 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
                  >
                    {Icon && (
                      <Icon
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">
                        {section.label}
                      </span>
                      {section.description && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {section.description}
                        </span>
                      )}
                    </span>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The one Settings layout for every tree (#1527 §14): a grouped left nav from
 * `md` up; below it the hub root is a list of sections and each section page
 * carries a "Settings" back link (list → detail). Every section is its own
 * URL, so back/forward and deep links work.
 */
export function SettingsLayout({
  title,
  description,
  groups,
  basePath,
  listHref,
  children,
}: Readonly<SettingsLayoutProps>) {
  const pathname = usePathname();
  const visible = groups
    .map((g) => ({
      ...g,
      sections: g.sections.filter((s) => s.show !== false),
    }))
    .filter((g) => g.sections.length > 0);
  const active = visible
    .flatMap((g) => g.sections)
    .find((s) => isActive(s, pathname));

  if (!active) {
    return (
      <div className="max-w-3xl">
        <PageHeader title={title} description={description} />
        <nav aria-label={`${title} sections`}>
          <SectionList groups={visible} />
        </nav>
        {children}
      </div>
    );
  }

  return (
    <>
      <Link
        href={listHref ?? basePath}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground md:hidden"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {title}
      </Link>
      {/* One h1: the section name on mobile (detail view), the hub name at md+. */}
      <PageHeader
        title={
          <>
            <span className="md:hidden">{active.label}</span>
            <span className="hidden md:inline">{title}</span>
          </>
        }
        description={active.description ?? description}
      />
      <div className="flex gap-8">
        <nav
          aria-label={`${title} sections`}
          className="hidden w-52 shrink-0 space-y-5 md:block"
        >
          {visible.map((group) => (
            <div key={group.title}>
              <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.sections.map((section) => {
                  const current = section.key === active.key;
                  const Icon = section.icon;
                  return (
                    <li key={section.key}>
                      <Link
                        href={section.href}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors",
                          current
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        {Icon && (
                          <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        )}
                        {section.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0 max-w-3xl flex-1">{children}</div>
      </div>
    </>
  );
}

export interface SettingsSaveBarProps {
  isSaving: boolean;
  onReset: () => void;
  /**
   * With dirty tracking the bar sticks to the bottom and shows only while the
   * form differs from what is saved. Left undefined, it renders inline and
   * always, as the old SettingsFormActions did.
   */
  isDirty?: boolean;
  saveLabel?: string;
  resetLabel?: string;
}

/** Reset + Save for a settings form; place it inside the `<form>`. */
export function SettingsSaveBar({
  isSaving,
  onReset,
  isDirty,
  saveLabel = "Save changes",
  resetLabel = "Reset",
}: Readonly<SettingsSaveBarProps>) {
  if (isDirty === false) return null;
  const tracked = isDirty === true;
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end",
        tracked &&
          "sticky bottom-0 z-10 rounded-lg border border-border bg-background/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80",
      )}
    >
      {tracked && (
        <p
          className="text-sm text-muted-foreground sm:mr-auto"
          aria-live="polite"
        >
          You have unsaved changes
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full sm:w-auto"
        onClick={onReset}
        disabled={isSaving}
      >
        {resetLabel}
      </Button>
      <Button
        type="submit"
        className="w-full sm:w-auto sm:min-w-[160px]"
        disabled={isSaving}
      >
        {isSaving && (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
        )}
        {saveLabel}
      </Button>
    </div>
  );
}
