import { Skeleton } from "@/components/ui/skeleton";

/** Org invite accept card — matches InviteAcceptPage chrome. */
export function InviteAcceptSkeleton() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-muted/40 p-4">
      <Skeleton className="mb-6 h-5 w-28" />
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-6 shadow-elevation-2">
        <div className="flex flex-col items-center space-y-2 text-center">
          <Skeleton className="mb-1 h-12 w-12 rounded-xl" />
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-3 pt-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4 mx-auto" />
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      </div>
    </main>
  );
}
