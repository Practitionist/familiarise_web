"use client";

import React from "react";
import Link, { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";

/**
 * Pending affordance. MUST be rendered as a DESCENDANT of <Link> for
 * useLinkStatus() to read that Link's navigation state (#15.5 contract).
 *
 * Debounced: the spinner starts at opacity-0 and fades in over a ~120ms
 * delayed transition, so it only becomes visible on slow navigations and
 * fast cache-hit navigations never flash it.
 */
function PendingIndicator({ className }: { className?: string }) {
  const { pending } = useLinkStatus();

  return (
    <Loader2
      aria-hidden
      className={cn(
        "h-3.5 w-3.5 shrink-0 animate-spin transition-opacity duration-150 [transition-delay:120ms] motion-reduce:animate-none",
        pending ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}

export interface NavLinkProps
  extends Omit<React.ComponentProps<typeof Link>, "href"> {
  href: React.ComponentProps<typeof Link>["href"];
  children: React.ReactNode;
  /** Extra classes applied to the inline pending spinner. */
  indicatorClassName?: string;
}

/**
 * A drop-in <Link> that renders its children plus a debounced inline pending
 * spinner while a navigation to its href is in flight. Generic enough for the
 * sidebar — callers keep full control of layout/active styling via children.
 */
export function NavLink({
  href,
  children,
  className,
  indicatorClassName,
  ...rest
}: NavLinkProps) {
  return (
    <Link href={href} className={className} {...rest}>
      {children}
      <PendingIndicator className={indicatorClassName} />
    </Link>
  );
}

export default NavLink;
