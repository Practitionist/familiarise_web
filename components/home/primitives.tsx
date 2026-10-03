"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { motion } from "framer-motion";

import { reveal, revealTransition, revealViewport } from "@/lib/motion";
import { cn } from "@/utils/tailwind";

/**
 * Landing design primitives.
 *
 * The page is one continuous dark surface; sections are separated by a
 * hairline rather than by alternating background colours, and every section
 * shares the same container width, vertical rhythm and heading pattern. Keep
 * new sections on these primitives so the page doesn't drift back into
 * per-section one-offs.
 */

/** Glassy card surface: near-transparent fill, crisp hairline, top highlight. */
export const surface =
  "rounded-2xl border border-white/[0.08] bg-white/[0.02] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]";

/** Hover affordance for interactive surfaces. */
export const surfaceInteractive =
  "transition-colors duration-300 hover:border-white/[0.16] hover:bg-white/[0.04]";

export const container = "mx-auto w-full max-w-6xl px-6 lg:px-8";

export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "li";
}) {
  const Component = as === "li" ? motion.li : motion.div;
  return (
    <Component
      variants={reveal}
      initial="hidden"
      whileInView="visible"
      viewport={revealViewport}
      transition={revealTransition(delay)}
      className={className}
    >
      {children}
    </Component>
  );
}

export function Section({
  children,
  className,
  bordered = true,
  ...props
}: ComponentPropsWithoutRef<"section"> & { bordered?: boolean }) {
  return (
    <section
      className={cn(
        "relative py-24 md:py-32",
        bordered && "border-t border-white/[0.06]",
        className,
      )}
      {...props}
    >
      <div className={container}>{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-5 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-zinc-400">
      <span aria-hidden className="h-px w-6 bg-zinc-600" />
      {children}
    </p>
  );
}

/**
 * Section heading: eyebrow, serif title, supporting line, and an optional
 * action aligned to the right on wide screens.
 */
export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  align = "left",
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  const centered = align === "center";
  return (
    <Reveal
      className={cn(
        "mb-14 flex flex-col gap-6 md:mb-16",
        !centered && action && "md:flex-row md:items-end md:justify-between",
        centered && "items-center text-center",
        className,
      )}
    >
      <div className={cn("max-w-2xl", centered && "mx-auto")}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="font-serif text-4xl leading-[1.05] tracking-tight text-white md:text-5xl lg:text-[3.5rem]">
          {title}
        </h2>
        {description && (
          <p className="mt-5 text-base leading-relaxed text-zinc-400 md:text-lg">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </Reveal>
  );
}

/** Italic, slightly dimmed emphasis inside a serif heading. */
export function Em({ children }: { children: ReactNode }) {
  return <em className="italic text-zinc-400">{children}</em>;
}
