import { Skeleton } from "@/components/ui/skeleton";

/** The Home layout in outline: Needs you, Next session and Money beside a sidebar. */
export function ExpertHomeSkeleton({
  withHeader = false,
}: Readonly<{ withHeader?: boolean }> = {}) {
  return (
    <output aria-busy="true" className="block">
      {withHeader && (
        <div className="mb-6 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      )}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-8">
          <div className="space-y-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-36 w-full rounded-xl" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-72" />
          </div>
        </div>
        <div className="space-y-6">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      </div>
      <span className="sr-only">Loading…</span>
    </output>
  );
}
