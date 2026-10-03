import { Skeleton } from "@/components/ui/skeleton";

/** Landing first-viewport: dark hero matching HeroSection. */
export function LandingHeroSkeleton() {
  return (
    <main className="min-h-screen w-full flex-1 overflow-hidden bg-zinc-950">
      <section className="relative flex min-h-[min(940px,100svh)] items-center overflow-hidden pb-16 pt-28 md:pb-20 md:pt-32">
        <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:48px_48px]" />
        <div className="relative z-10 mx-auto w-full max-w-[1500px] px-4 md:px-8 lg:px-12">
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)] lg:gap-16">
            <div className="space-y-6">
              <Skeleton className="h-8 w-64 rounded-full bg-zinc-800" />
              <div className="space-y-3">
                <Skeleton className="h-16 w-full max-w-2xl bg-zinc-800 sm:h-24" />
                <Skeleton className="h-16 w-4/5 max-w-xl bg-zinc-800 sm:h-24" />
              </div>
              <Skeleton className="h-6 w-full max-w-xl bg-zinc-800" />
              <Skeleton className="h-16 w-full max-w-2xl rounded-2xl bg-zinc-800" />
              <div className="flex gap-3">
                <Skeleton className="h-7 w-24 rounded-full bg-zinc-800" />
                <Skeleton className="h-7 w-24 rounded-full bg-zinc-800" />
                <Skeleton className="h-7 w-24 rounded-full bg-zinc-800" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-40 rounded-2xl bg-zinc-800" />
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
