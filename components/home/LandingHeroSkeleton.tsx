import { Skeleton } from "@/components/ui/skeleton";

/** Landing first-viewport: dark two-column hero matching HeroSection. */
export function LandingHeroSkeleton() {
  return (
    <main className="flex-1 w-full min-h-screen overflow-hidden bg-zinc-950">
      <section className="relative pt-32 pb-20 md:pb-28 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />
        <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12 relative z-10">
          <div className="grid lg:grid-cols-12 gap-12 lg:gap-10 items-center">
            <div className="lg:col-span-7 space-y-6">
              <Skeleton className="h-7 w-64 rounded-full bg-zinc-800" />
              <Skeleton className="h-14 w-full max-w-xl bg-zinc-800 sm:h-16" />
              <Skeleton className="h-5 w-full max-w-lg bg-zinc-800" />
              <Skeleton className="h-14 w-full max-w-xl rounded-2xl bg-zinc-900 border border-white/10" />
              <div className="flex flex-wrap gap-2 pt-1">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton
                    key={i}
                    className="h-7 w-20 rounded-full bg-zinc-800"
                  />
                ))}
              </div>
              <div className="grid max-w-xl grid-cols-3 gap-6 pt-8 border-t border-white/[0.08]">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-8 w-20 bg-zinc-800" />
                    <Skeleton className="h-3 w-24 bg-zinc-800" />
                  </div>
                ))}
              </div>
            </div>
            <div className="lg:col-span-5">
              <Skeleton className="h-[420px] w-full rounded-2xl bg-zinc-900 border border-white/10" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
