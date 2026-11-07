import { BRAND_NAME } from "@/lib/brand";
import { cn } from "@/utils/tailwind";

const SIZE_CLASSES = {
  sm: "text-xl",
  md: "text-2xl",
  lg: "text-3xl",
  nav: "text-xl md:text-2xl",
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
        "inline-block whitespace-nowrap font-display font-bold leading-none tracking-tight",
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        className,
      )}
    >
      {BRAND_NAME}
    </span>
  );
}

/** Badge-sized letter mark; decorative, so the caller names the brand in adjacent text. */
export function BrandMark({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-primary font-display text-[9px] font-bold leading-none text-primary-foreground",
        className,
      )}
    >
      {BRAND_NAME.charAt(0)}
    </span>
  );
}
