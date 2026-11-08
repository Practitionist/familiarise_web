import { BRAND_NAME } from "@/lib/brand";
import { cn } from "@/utils/tailwind";

// Tracking tightens with size: -0.01em at 20px and below, -0.02em from 24px.
const SIZE_CLASSES = {
  sm: "text-xl tracking-[-0.01em]",
  md: "text-2xl tracking-[-0.02em]",
  lg: "text-3xl tracking-[-0.02em]",
  nav: "text-xl tracking-[-0.01em] md:text-2xl md:tracking-[-0.02em]",
} as const;

const TONE_CLASSES = {
  // Theme tokens, so it inverts wherever the dark token set applies.
  default: "text-primary",
  // Dark surfaces that are not token-themed: the dark hero, footer and drawer.
  inverse: "text-white",
} as const;

interface BrandWordmarkProps {
  size?: keyof typeof SIZE_CLASSES;
  tone?: keyof typeof TONE_CLASSES;
  className?: string;
}

/** The site's only brand mark: the product name as text, never an image. */
export function BrandWordmark({
  size = "md",
  tone = "default",
  className,
}: Readonly<BrandWordmarkProps>) {
  return (
    <span
      translate="no"
      className={cn(
        "inline-block whitespace-nowrap font-display font-semibold leading-none",
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        className,
      )}
    >
      {BRAND_NAME}
    </span>
  );
}
