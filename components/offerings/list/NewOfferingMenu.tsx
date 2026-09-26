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

const NEW_OFFERINGS = [
  { type: "consultation", label: "1:1 session" },
  { type: "subscription", label: "Subscription" },
  { type: "webinar", label: "Webinar" },
  { type: "class", label: "Class" },
] as const;

/** #1527 §7.2 — one "+ New offering" entry instead of four section buttons. */
export function NewOfferingMenu({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          New offering
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
