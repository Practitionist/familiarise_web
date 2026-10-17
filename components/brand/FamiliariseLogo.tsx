import { FAMILIARISE_MARK_PATHS } from "@/lib/brand";
import { cn } from "@/utils/tailwind";

export function FamiliariseMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("size-9 shrink-0", className)}
    >
      {FAMILIARISE_MARK_PATHS.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

export function FamiliariseLogo({ className }: { className?: string }) {
  return (
    <span
      aria-label="Familiarise"
      className={cn("inline-flex items-center gap-1.5", className)}
    >
      <FamiliariseMark />
      <span className="text-[22px] font-semibold tracking-[-0.055em]">
        familiarise
      </span>
    </span>
  );
}
