"use client";

import Link from "next/link";
import { LifeBuoy, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { OverflowItem } from "@/lib/appointments/adapter";
import { cn } from "@/utils/tailwind";

const DESTRUCTIVE =
  "text-red-600 focus:bg-red-50 focus:text-red-700 dark:text-red-400 dark:focus:bg-red-900/20 dark:focus:text-red-300";

function MenuItem({ item }: { item: OverflowItem }) {
  if (item.href && !item.disabled) {
    return (
      <DropdownMenuItem asChild>
        <Link href={item.href} className={cn(item.destructive && DESTRUCTIVE)}>
          {item.label}
        </Link>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={item.disabled}
      onClick={item.onClick}
      className={cn(item.destructive && DESTRUCTIVE)}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

/**
 * The detail page's secondary actions behind one "More" trigger: routine
 * items, then Get help, then destructive items last behind a separator.
 */
export function DetailActionsMenu({
  items,
  onHelp,
}: {
  items: OverflowItem[];
  onHelp: () => void;
}) {
  const routine = items.filter((item) => !item.destructive);
  const destructive = items.filter((item) => item.destructive);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="More actions">
          <MoreHorizontal className="h-4 w-4 sm:mr-1.5" />
          <span className="hidden sm:inline">More</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {routine.map((item) => (
          <MenuItem key={item.key} item={item} />
        ))}
        <DropdownMenuItem onClick={onHelp}>
          <LifeBuoy className="mr-2 h-4 w-4" />
          Get help
        </DropdownMenuItem>
        {destructive.length > 0 && <DropdownMenuSeparator />}
        {destructive.map((item) => (
          <MenuItem key={item.key} item={item} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
