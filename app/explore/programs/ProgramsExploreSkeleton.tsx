import { Skeleton } from "@/components/ui/skeleton";
import { ProgramsHeroCopy } from "./components/HeroCopy";

/** Explore programs list: dark hero + tabs/filters + carousel rows.
 *
 * The hero's static copy is rendered for real — identical to
 * ProgramsInteractiveContent's hero — because a skeleton made only of pulsing
 * boxes cannot fire First Contentful Paint (#1102): FCP needs text, an image,
 * canvas or SVG. Only the data-dependent parts stay as skeletons. */
export function ProgramsExploreSkeleton() {
  return (
    <main className="min-h-screen bg-background">
      <section className="relative bg-zinc-950 px-4 pb-20 pt-32 md:px-8 lg:px-12">
        <div className="mx-auto max-w-4xl text-center">
          <ProgramsHeroCopy />

          <div className="flex flex-wrap justify-center gap-8 md:gap-16">
            {["Classes Available", "Live Webinars", "Students Enrolled"].map(
              (label) => (
                <div key={label} className="text-center">
                  <Skeleton className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50" />
                  <Skeleton className="h-8 w-16 bg-zinc-800 rounded-lg mx-auto mb-1" />
                  <div className="text-sm text-zinc-500">{label}</div>
                </div>
              ),
            )}
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
