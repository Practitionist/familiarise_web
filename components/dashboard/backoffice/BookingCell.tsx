import Link from "next/link";

import { bookingHref } from "@/lib/backoffice/booking-href";
import { SESSION_TYPE_LABEL } from "@/lib/labels/org-labels";
import type { BookingRef } from "@/lib/data/booking-title";

/** A booking in a back-office money row: its title, its kind, and a link to open it. */
export function BookingCell({
  booking,
  basePath,
}: Readonly<{ booking: BookingRef | null | undefined; basePath: string }>) {
  if (!booking) {
    return <span className="text-sm text-muted-foreground">No booking</span>;
  }
  return (
    <div className="min-w-0">
      <Link
        href={bookingHref(basePath, booking.id)}
        className="block truncate text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        {booking.title}
      </Link>
      <p className="truncate text-xs text-muted-foreground">
        {SESSION_TYPE_LABEL[booking.type]}
      </p>
    </div>
  );
}
