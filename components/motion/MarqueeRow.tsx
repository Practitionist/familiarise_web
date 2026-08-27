"use client";

interface MarqueeRowProps {
  children: React.ReactNode;
  /** Seconds for one full loop across the track. */
  duration?: number;
  reverse?: boolean;
  className?: string;
  /** Fade the left/right edges of the viewport container. */
  fadeEdges?: boolean;
}

/**
 * Infinite horizontal marquee built on the .animate-marquee keyframes in
 * globals.css. The track carries the children twice; translateX(-50%) of the
 * doubled track equals exactly one copy width, so the loop is seamless.
 *
 * Hovering pauses travel so items stay readable/clickable. Under
 * prefers-reduced-motion globals.css stops the animation and hands scrolling
 * back to the user.
 */
export function MarqueeRow({
  children,
  duration = 40,
  reverse = false,
  className = "",
  fadeEdges = true,
}: MarqueeRowProps) {
  return (
    <div
      className={`group relative overflow-hidden ${
        fadeEdges ? "mask-fade-x" : ""
      } ${className}`}
    >
      <div
        className={`flex w-max gap-4 pr-4 group-hover:[animation-play-state:paused] md:gap-6 md:pr-6 ${
          reverse ? "animate-marquee-reverse" : "animate-marquee"
        }`}
        style={{ animationDuration: `${duration}s` }}
      >
        {children}
        {children}
      </div>
    </div>
  );
}
