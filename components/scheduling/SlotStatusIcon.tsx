"use client";

import { ArrowRightLeft, Check, Lock, User, Users } from "lucide-react";

import type { SlotStatusIconName } from "@/lib/scheduling/interval-status-tokens";
import { cn } from "@/utils/tailwind";

const ICONS = {
  lock: Lock,
  person: User,
  people: Users,
  check: Check,
  move: ArrowRightLeft,
} as const satisfies Record<SlotStatusIconName, unknown>;

/** The glyph that tells a state apart without its colour; always decorative. */
export function SlotStatusIcon({
  name,
  className,
}: Readonly<{ name: SlotStatusIconName | undefined; className?: string }>) {
  if (!name) return null;
  const Icon = ICONS[name];
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      data-slot-icon={name}
      className={cn("h-2.5 w-2.5 shrink-0", className)}
    />
  );
}
