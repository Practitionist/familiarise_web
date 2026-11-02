"use client";

import { ChevronDown } from "lucide-react";

import { useUrlTab, type UrlTab } from "@/components/dashboard/UrlTabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/utils/tailwind";

/**
 * URL tabs (`?tab=`, like `UrlTabs`) that show the first `maxVisible` shown
 * tabs and list the rest in a "More" menu beside the tab list.
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

  const inline = visible.slice(0, maxVisible);
  const overflow = visible.slice(maxVisible);
  const activeOverflow = overflow.find((t) => t.value === active);

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
            <DropdownMenuTrigger
              aria-label={
                activeOverflow
                  ? `More tabs: ${activeOverflow.label}`
                  : undefined
              }
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-muted-foreground ring-offset-background transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                activeOverflow && "bg-muted text-foreground",
              )}
            >
              {activeOverflow?.label ?? "More"}
              <ChevronDown className="h-4 w-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                value={activeOverflow?.value ?? ""}
                onValueChange={onValueChange}
              >
                {overflow.map((t) => (
                  <DropdownMenuRadioItem key={t.value} value={t.value}>
                    {t.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
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
