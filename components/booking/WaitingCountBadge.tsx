import { Badge } from "@/components/ui/badge";

/** Host-side count of learners queued for a seat; renders nothing at zero and never names anyone. */
export function WaitingCountBadge({ count }: Readonly<{ count: number }>) {
  if (count <= 0) return null;
  return (
    <Badge
      variant="secondary"
      role="status"
      aria-label={`${count} ${count === 1 ? "person" : "people"} waiting for a seat`}
      className="px-2 py-0 text-[11px] tabular-nums"
    >
      {count} waiting
    </Badge>
  );
}
