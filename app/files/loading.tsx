import { Skeleton } from "@/components/ui/skeleton";

/** The viewer's title row and preview frame; its pages never call notFound() or redirect(). */
export default function Loading() {
  return (
    <output
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-[80vh] w-full rounded-lg" />
    </output>
  );
}
