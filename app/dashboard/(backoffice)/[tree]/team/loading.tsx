import { TableSkeleton } from "@/components/dashboard/DashboardSkeletons";

/** #1927 — matches the sibling list pages (`users`, `leads`, `payments`). */
export default function Loading() {
  return <TableSkeleton />;
}
