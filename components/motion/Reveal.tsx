"use client";

import { motion, type Variants } from "framer-motion";
import { fadeUp, staggerContainer } from "./presets";

type RevealVariant = "fadeUp" | "fadeIn" | "blurIn" | "scaleIn";

const VARIANTS: Record<RevealVariant, Variants> = {
  fadeUp,
  fadeIn: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.6, ease: "easeOut" } },
  },
  blurIn: {
    hidden: { opacity: 0, filter: "blur(8px)", y: 12 },
    visible: {
      opacity: 1,
      filter: "blur(0px)",
      y: 0,
      transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
    },
  },
  scaleIn: {
    hidden: { opacity: 0, scale: 0.94 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
    },
  },
};

interface RevealProps {
  children: React.ReactNode;
  variant?: RevealVariant;
  /** Seconds of delay before the reveal starts. */
  delay?: number;
  className?: string;
  /** Animate every time the element enters the viewport (default: once). */
  repeat?: boolean;
}

/**
 * Scroll-triggered entrance for any block. Renders a plain div until it is in
 * view, so content is never trapped invisible if JS fails — the initial state
 * only applies once the element mounts as a client component.
 */
export function Reveal({
  children,
  variant = "fadeUp",
  delay = 0,
  className,
  repeat = false,
}: RevealProps) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: !repeat, margin: "-80px" }}
      variants={VARIANTS[variant]}
      transition={{ delay }}
    >
      {children}
    </motion.div>
  );
}

/** Parent that staggers its immediate <RevealItem> children into view. */
export function RevealGroup({
  children,
  stagger = 0.08,
  delayChildren = 0.05,
  className,
}: {
  children: React.ReactNode;
  stagger?: number;
  delayChildren?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-60px" }}
      variants={staggerContainer(stagger, delayChildren)}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div className={className} variants={fadeUp}>
      {children}
    </motion.div>
  );
}
