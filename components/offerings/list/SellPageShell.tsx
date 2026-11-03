import Link from "next/link";
import type { ReactNode } from "react";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import {
  sellPageHref,
  type SellPage,
  type SellTab,
} from "@/lib/dashboard/sell-pages";
import { cn } from "@/utils/tailwind";

import { NewOfferingMenu } from "./NewOfferingMenu";

export interface SellTabs<T extends SellTab> {
  page: SellPage;
  options: readonly { value: T; label: string }[];
  active: T;
}

/**
 * A Sell page: the "+ New" picker, `?tab=` links that navigate (the server
 * renders only the active panel), and that panel.
 */
export function SellPageShell<T extends SellTab>({
  consultantId,
  title,
  description,
  tabs,
  children,
}: Readonly<{
  consultantId: string;
  title: string;
  description: string;
  /** Omitted on a page with a single list. */
  tabs?: SellTabs<T>;
  children: ReactNode;
}>) {
  return (
    <>
      <DashboardHeader
        title={title}
        description={description}
        actions={<NewOfferingMenu consultantId={consultantId} />}
      />
      {tabs && (
        <nav
          aria-label={`${title} sections`}
          className="mb-6 inline-flex rounded-lg bg-muted p-1"
        >
          {tabs.options.map((tab) => {
            const active = tab.value === tabs.active;
            return (
              <Link
                key={tab.value}
                href={sellPageHref(consultantId, tabs.page, tab.value)}
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
      )}
      <DashboardContent>{children}</DashboardContent>
    </>
  );
}
