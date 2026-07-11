"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";

export function AnimatedNumber({
  value,
  suffix = "",
  className = "text-4xl md:text-5xl font-bold text-white tabular-nums",
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });
  const [displayValue, setDisplayValue] = useState(0);

  const animate = useCallback(() => {
    const duration = 2000;
    const steps = 60;
    const increment = value / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, duration / steps);
    return () => clearInterval(timer);
  }, [value]);

  useEffect(() => {
    if (isInView) {
      return animate();
    }
  }, [isInView, animate]);

  return (
    <motion.span ref={ref} className={className}>
      {value % 1 !== 0
        ? displayValue.toFixed(1)
        : displayValue.toLocaleString()}
      {suffix}
    </motion.span>
  );
}
