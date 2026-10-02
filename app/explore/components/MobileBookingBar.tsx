"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";

interface MobileBookingBarProps {
  targetId: string;
  label: string;
  context: string;
}

/** A small route-local shortcut to the existing booking control. */
export function MobileBookingBar({
  targetId,
  label,
  context,
}: Readonly<MobileBookingBarProps>) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => setShow(!entry.isIntersecting),
      { threshold: 0.05 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);

  if (!show) return null;

  return (
    <section
      className="explore-mobile-booking md:hidden"
      aria-label="Booking shortcut"
    >
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{context}</p>
        <p className="text-sm font-semibold text-foreground">{label}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          const target = document.getElementById(targetId);
          if (!target) return;

          // Keep focus in the booking area when the shortcut disappears on scroll.
          if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
          target.focus({ preventScroll: true });

          const reduce = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          target.scrollIntoView({
            behavior: reduce ? "instant" : "smooth",
            block: "start",
          });
        }}
        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        View options <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
