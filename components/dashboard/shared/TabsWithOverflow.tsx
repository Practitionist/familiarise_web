"use client";

import { ChevronDown } from "lucide-react";

import { useUrlTab, type UrlTab } from "@/components/dashboard/UrlTabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * URL tabs (`?tab=`, like `UrlTabs`) that show the first `maxVisible` shown
 * tabs and list the rest in a "More" menu beside the tab list. An active tab
 * from the menu takes the last inline slot, so the open panel always has a
 * real, selected tab labelling it.
 */
export function TabsWithOverflow({
  tabs,
  maxVisible = 3,
  paramName = "tab",
  className,
}: Readonly<{
  tabs: UrlTab[];
  maxVisible?: number;
  paramName?: string;
  className?: string;
}>) {
  const visible = tabs.filter((t) => t.show !== false);
  const { active, onValueChange } = useUrlTab(visible, paramName);

  if (!active) return null;

  const first = visible.slice(0, maxVisible);
  const activeTab = visible.find((t) => t.value === active);
  const inline =
    activeTab && !first.includes(activeTab)
      ? [...first.slice(0, maxVisible - 1), activeTab]
      : first;
  const overflow = visible.filter((t) => !inline.includes(t));

  return (
    <Tabs value={active} onValueChange={onValueChange} className={className}>
      {/* The menu button sits beside the tablist: a tablist holds only tabs. */}
      <div className="flex max-w-full items-center gap-1">
        <TabsList>
          {inline.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-muted-foreground ring-offset-background transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              More
              <ChevronDown className="h-4 w-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {overflow.map((t) => (
                <DropdownMenuItem
                  key={t.value}
                  onSelect={() => onValueChange(t.value)}
                >
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {visible.map((t) => (
        <TabsContent key={t.value} value={t.value} className="space-y-6">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
