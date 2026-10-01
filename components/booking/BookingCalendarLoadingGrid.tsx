import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/utils/tailwind";

/** Preserve the visible month's height without suggesting any date is available. */
export function BookingCalendarLoadingGrid({
  month,
  className,
}: Readonly<{ month: Date; className?: string }>) {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const mondayOffset = (firstDay + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((mondayOffset + days) / 7) * 7;

  return (
    <div
      aria-hidden="true"
      data-testid="calendar-loading-grid"
      className={cn("col-span-7 grid grid-cols-7 gap-1 py-2", className)}
    >
      {Array.from({ length: cells }, (_, index) => (
        <Skeleton
          key={index}
          className="h-10 w-full rounded-lg bg-muted motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
