/** Suspense fallbacks for the landing sections; they mirror each section's
 *  dark surface, heading block and grid so the page doesn't jump on resolve. */

const block = "rounded bg-white/[0.06] animate-pulse";
const card =
  "rounded-2xl border border-white/[0.08] bg-white/[0.02] animate-pulse";

function HeadingSkeleton() {
  return (
    <div className="mb-14 space-y-4 md:mb-16">
      <div className={`${block} h-3 w-28`} />
      <div className={`${block} h-12 w-full max-w-md`} />
      <div className={`${block} h-5 w-full max-w-lg`} />
    </div>
  );
}

export function FeaturedExpertsSkeleton() {
  return (
    <section className="border-t border-white/[0.06] bg-black py-24 md:py-32">
      <div className="mx-auto w-full max-w-6xl px-6 lg:px-8">
        <HeadingSkeleton />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className={`${card} h-[260px]`} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function TestimonialsSkeleton() {
  return (
    <section className="border-t border-white/[0.06] bg-black py-24 md:py-32">
      <div className="mx-auto w-full max-w-6xl px-6 lg:px-8">
        <HeadingSkeleton />
        <div className={`${card} h-[280px]`} />
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className={`${card} h-[180px]`} />
          ))}
        </div>
      </div>
    </section>
  );
}
