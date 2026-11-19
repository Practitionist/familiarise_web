import { formatDistanceToNow } from "date-fns";

/** "18 days ago" for an audit or activity row; every feed prints ages through this. */
export function timeAgo(iso: string): string {
  const date = new Date(iso);
  // formatDistanceToNow throws a RangeError on an Invalid Date.
  if (Number.isNaN(date.getTime())) return "—";
  // Past 30 days a relative age loses the precision a feed wants: show the date.
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days > 30) {
    return date.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  return formatDistanceToNow(date, { addSuffix: true });
}
