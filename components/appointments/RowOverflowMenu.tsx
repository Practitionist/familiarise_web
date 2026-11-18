"use client";

import type * as React from "react";
import Link from "next/link";
import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { OverflowItem } from "@/lib/appointments/adapter";
import { cn } from "@/utils/tailwind";

/** The row opens its detail on Enter and Space; the menu keeps those keys. */
const keepRowKeys = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

export function RowOverflowMenu({ items }: { items: OverflowItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={keepRowKeys}
          aria-label="More actions"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={keepRowKeys}
      >
        {items.map((item) => {
          // Prefetchable page navigations render as a real link so the
          // destination prefetches on hover; the row click must still not
          // fire (card-vs-menu), hence the preserved stopPropagation.
          // Button-only surfaces (Sheet/detail) keep using item.onClick.
          if (item.href && !item.disabled) {
            return (
              <DropdownMenuItem key={item.key} asChild>
                <Link
                  href={item.href}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    item.destructive &&
                      "text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400",
                  )}
                >
                  {item.label}
                </Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem
              key={item.key}
              disabled={item.disabled}
              onClick={(e) => {
                e.stopPropagation();
                item.onClick();
              }}
              className={cn(
                item.destructive &&
                  "text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400",
              )}
            >
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
