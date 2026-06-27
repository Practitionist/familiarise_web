"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// Lightweight scroll-in reveal — replaces framer-motion's `whileInView` across the
// landing sections so framer-motion stays out of the `/` route bundle (#932). An
// IntersectionObserver toggles a data attribute that drives the `revealUp` CSS
// keyframe (app/globals.css); reduced-motion users get the content immediately.
interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Stagger, in seconds — mirrors framer's `transition.delay`. */
  delay?: number;
  style?: CSSProperties;
}

export function Reveal({ children, className, delay = 0, style }: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-reveal={visible ? "visible" : "hidden"}
      style={delay ? { animationDelay: `${delay}s`, ...style } : style}
      className={className}
    >
      {children}
    </div>
  );
}

// Ref + once-only in-view flag — for components that need the boolean to drive
// their own logic (e.g. the hero stat counters) rather than a wrapper animation.
export function useInViewOnce<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, inView] as const;
}
