import { Skeleton } from "@/components/ui/skeleton";
import { LandingContainer } from "./LandingShared";

/** Landing first-viewport: dark hero matching LandingHero. */
export function LandingHeroSkeleton() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading Familiarise"
      className="flex-1 w-full min-h-screen overflow-hidden bg-black"
    >
      <section className="relative overflow-hidden">
        <LandingContainer className="pb-10 pt-32 sm:pt-36 lg:pt-40">
          <div
            aria-hidden="true"
            className="grid items-center gap-14 lg:grid-cols-[1.25fr_1fr] lg:gap-16"
          >
            <div className="space-y-7">
              <Skeleton className="h-8 w-64 max-w-full rounded-full bg-zinc-800 motion-reduce:animate-none" />
              <Skeleton className="h-40 w-full max-w-lg bg-zinc-800 motion-reduce:animate-none" />
              <Skeleton className="h-14 w-full max-w-lg bg-zinc-800 motion-reduce:animate-none" />
              <div className="flex flex-col gap-4 sm:flex-row">
                <Skeleton className="h-12 w-full rounded-xl bg-zinc-800 motion-reduce:animate-none sm:w-40" />
                <Skeleton className="h-12 w-full rounded-xl bg-zinc-800 motion-reduce:animate-none sm:w-40" />
              </div>
            </div>
            <Skeleton className="mx-auto h-[520px] w-full max-w-[440px] rounded-3xl bg-zinc-800 motion-reduce:animate-none" />
          </div>
          <div
            aria-hidden="true"
            className="mt-12 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-white/10 pt-7 sm:flex sm:flex-wrap sm:gap-14"
          >
            {[1, 2, 3].map((key) => (
              <div key={key} className="space-y-3">
                <Skeleton className="h-3 w-20 bg-zinc-800 motion-reduce:animate-none" />
                <Skeleton className="h-7 w-12 bg-zinc-800 motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        </LandingContainer>
      </section>
    </main>
  );
}
