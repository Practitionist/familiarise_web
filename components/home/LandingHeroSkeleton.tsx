import { Skeleton } from "@/components/ui/skeleton";

/** Landing first-viewport: dark split hero matching HeroSection. */
export function LandingHeroSkeleton() {
  return (
    <main className="flex-1 w-full min-h-svh overflow-hidden bg-black">
      <section className="relative pb-24 pt-[calc(var(--header-height)+4rem)] lg:pt-[calc(var(--header-height)+6rem)]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_-5%,rgba(255,255,255,0.10),transparent_70%)]" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-16 px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-20 lg:px-8">
          <div className="space-y-6">
            <Skeleton className="h-8 w-72 rounded-full bg-white/[0.06]" />
            <Skeleton className="h-16 w-full max-w-lg bg-white/[0.06] sm:h-20" />
            <Skeleton className="h-16 w-4/5 max-w-md bg-white/[0.06] sm:h-20" />
            <Skeleton className="h-5 w-full max-w-md bg-white/[0.06]" />
            <div className="flex flex-wrap gap-3 pt-4">
              <Skeleton className="h-12 w-44 rounded-full bg-white/[0.06]" />
              <Skeleton className="h-12 w-40 rounded-full bg-white/[0.06]" />
            </div>
          </div>
          <div className="space-y-3">
            <Skeleton className="h-44 w-full rounded-2xl bg-white/[0.04]" />
            <Skeleton className="ml-12 h-60 rounded-2xl bg-white/[0.04]" />
          </div>
        </div>
      </section>
    </main>
  );
}
