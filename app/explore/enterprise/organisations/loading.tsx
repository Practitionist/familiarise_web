/**
 * Loading skeleton for the organisations directory.
 *
 * Renders the dark hero band the real page renders, for two reasons:
 *
 *  1. HeaderSpacer decides at SSR whether this route needs top padding, and it
 *     treats this route as having a full-bleed hero. A skeleton without one
 *     therefore started underneath the fixed navbar.
 *  2. The skeleton painted a light surface under a bar this route promises will
 *     be dark, so the nav's white text sat on white and vanished. The navbar now
 *     derives its treatment from `[data-nav-sentinel]`, so carrying the sentinel
 *     here keeps the loading and loaded states consistent by construction.
 */
export default function Loading() {
  return (
    <main className="min-h-screen bg-background">
      <div data-nav-sentinel aria-hidden="true" />
      <section className="relative overflow-hidden bg-zinc-950 pt-32 pb-16">
        <div className="grid-pattern absolute inset-0 opacity-20" />
        <div className="relative z-10 mx-auto max-w-[1400px] px-4 md:px-8">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6">
            <div className="h-9 w-56 animate-pulse rounded-full bg-zinc-800" />
            <div className="h-12 w-80 animate-pulse rounded-lg bg-zinc-800" />
            <div className="h-5 w-full max-w-xl animate-pulse rounded bg-zinc-900" />
          </div>
        </div>
      </section>

      <section className="py-10 md:py-16">
        <div className="mx-auto max-w-[1400px] px-4 md:px-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[260px_1fr]">
            <div className="hidden h-96 animate-pulse rounded-2xl bg-muted lg:block" />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-56 animate-pulse rounded-2xl bg-muted"
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
