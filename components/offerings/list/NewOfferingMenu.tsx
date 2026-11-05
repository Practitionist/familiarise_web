"use client";

import Link from "next/link";
import { ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SellableKind } from "@/lib/dashboard/sell-pages";

const NEW_OFFERINGS: readonly { type: SellableKind; label: string }[] = [
  { type: "consultation", label: "1:1 consultation" },
  { type: "subscription", label: "Subscription" },
  { type: "webinar", label: "Webinar" },
  { type: "class", label: "Class" },
  { type: "digital-product", label: "Digital product" },
];

/** Every Sell page's "+ New": pick a kind, then its editor opens. */
export function NewOfferingMenu({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          New
          <ChevronDown className="ml-1.5 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {NEW_OFFERINGS.map(({ type, label }) => (
          <DropdownMenuItem key={type} asChild>
            <Link
              href={`/dashboard/consultant/${consultantId}/offerings/${type}/new`}
            >
              {label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
