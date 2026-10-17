import { Skeleton } from "@/components/ui/skeleton";

/** Explore programs list: light editorial hero + tabs/filters + carousel rows. */
export function ProgramsExploreSkeleton() {
  return (
    <main className="explore-page min-h-screen">
      <section className="relative bg-[#faf9f6] px-4 pb-12 pt-12 md:px-8 lg:px-12">
        <div className="mx-auto max-w-[1600px] space-y-6">
          <Skeleton className="h-6 w-28 rounded-full bg-muted" />
          <Skeleton className="h-12 w-full max-w-xl bg-muted" />
          <Skeleton className="h-5 w-full max-w-lg bg-muted" />
          <div className="grid max-w-xl grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-8 w-14 bg-muted" />
                <Skeleton className="h-3 w-20 bg-muted" />
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1600px] space-y-8 px-4 py-10 md:px-8 md:py-16 lg:px-12">
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-28 rounded-full" />
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-6 w-40" />
          <div className="flex gap-4 overflow-hidden">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton
                key={i}
                className="h-48 w-[280px] shrink-0 rounded-xl"
              />
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-6 w-36" />
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-9 w-24 rounded-full" />
            ))}
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <Skeleton key={i} className="h-56 rounded-xl" />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
