"use client";

import { useEffect, useState } from "react";

/**
 * A timestamp in the VIEWER's timezone.
 *
 * The page around this is a server component, and `toLocaleString("en-IN")`
 * with no `timeZone` there resolves against the SERVER's zone — on Netlify,
 * UTC. That printed a slot time and a payment deadline that were both hours
 * off for everyone, on the one page where being wrong about the deadline costs
 * the buyer their slot.
 *
 * Rendered after mount rather than during SSR: the zone is only knowable in the
 * browser, and formatting on the server would just reintroduce the bug as a
 * hydration mismatch. The ISO string is the honest placeholder in between.
 */
export function ViewerLocalTime({
  value,
  className,
}: Readonly<{ value: string; className?: string }>) {
  const [formatted, setFormatted] = useState<string | null>(null);

  useEffect(() => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;
    setFormatted(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZoneName: "short",
      }).format(date),
    );
  }, [value]);

  return (
    <span className={className} suppressHydrationWarning>
      {formatted ?? value.slice(0, 16).replace("T", " ")}
    </span>
  );
}
