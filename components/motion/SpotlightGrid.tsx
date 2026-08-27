"use client";

import { useRef } from "react";

/**
 * Cursor-following spotlight over a hairline grid. Writes --sx/--sy (px) on
 * the container; the .spotlight-grid utility in globals.css paints both the
 * masked grid and the soft radial from those variables. Purely decorative —
 * pointer-events: none, and static fallback position when untouched.
 */
export function SpotlightGrid({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "mouse" || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    ref.current.style.setProperty("--sx", `${e.clientX - rect.left}px`);
    ref.current.style.setProperty("--sy", `${e.clientY - rect.top}px`);
  }

  return (
    <div
      ref={ref}
      aria-hidden
      onPointerMove={onPointerMove}
      className={`spotlight-grid ${className}`}
    />
  );
}
