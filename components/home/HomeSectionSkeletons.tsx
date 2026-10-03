export function BenefitsSkeleton() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-zinc-100 to-white">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-6">
            <div className="h-6 w-24 bg-muted/50 rounded animate-pulse" />
            <div className="h-10 w-3/4 bg-muted/50 rounded animate-pulse" />
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="h-5 bg-muted/50 rounded animate-pulse"
                  style={{ width: `${70 + i * 5}%` }}
                />
              ))}
            </div>
            <div className="flex gap-4 pt-2">
              <div className="h-12 w-36 bg-muted/50 rounded-xl animate-pulse" />
              <div className="h-12 w-36 bg-muted/50 rounded-xl animate-pulse" />
            </div>
          </div>
          <div className="h-[400px] bg-muted/50 rounded-2xl animate-pulse" />
        </div>
      </div>
    </section>
  );
}

export function FeaturedExpertsSkeleton() {
  return (
    <section className="bg-zinc-100 py-20 dark:bg-zinc-950 md:py-28">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <div className="mb-10 space-y-3">
          <div className="h-4 w-28 animate-pulse rounded bg-muted" />
          <div className="h-10 w-full max-w-xl animate-pulse rounded bg-muted" />
          <div className="h-5 w-full max-w-2xl animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-80 animate-pulse rounded-2xl border border-border bg-muted"
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function TestimonialsSkeleton() {
  return (
    <section className="bg-background py-20 md:py-28">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <div className="mb-10 max-w-3xl space-y-3">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="h-10 w-full max-w-xl animate-pulse rounded bg-muted" />
          <div className="h-5 w-full max-w-2xl animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-2xl border border-border bg-muted"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
