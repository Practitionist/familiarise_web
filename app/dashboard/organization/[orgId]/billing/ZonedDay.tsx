"use client";

import { useZonedFormat } from "@/lib/time/zoned-format";

/** A moment (a payment, a posting, a wallet entry) in the profile zone the org layout pins; invoice dates use `formatInvoiceDate`. */
export function ZonedDay({
  at,
  withTime = false,
}: Readonly<{ at: string | null; withTime?: boolean }>) {
  const format = useZonedFormat();
  if (!at) return <>—</>;
  return <>{format(at, withTime ? "d MMM yyyy, h:mm a" : "d MMM yyyy")}</>;
}
