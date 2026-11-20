"use client";

import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { PersonVM } from "@/lib/appointments/view-model";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

/** The person a booking is with; a host's group audience is a group icon, never initials. */
export function CounterpartAvatar({
  counterpart,
  className,
  fallbackClassName,
}: Readonly<{
  counterpart: PersonVM;
  className: string;
  fallbackClassName: string;
}>) {
  if (counterpart.audience) {
    return (
      <Avatar className={className} aria-hidden>
        <AvatarFallback className={fallbackClassName}>
          <Users className="h-1/2 w-1/2 text-muted-foreground" />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Avatar className={className}>
      <AvatarImage
        src={counterpart.image ?? undefined}
        alt={counterpart.name}
      />
      <AvatarFallback className={fallbackClassName}>
        {initials(counterpart.name) || "?"}
      </AvatarFallback>
    </Avatar>
  );
}
