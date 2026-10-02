export function BenefitsSkeleton() {
  return (
    <section className="py-20 md:py-28 bg-background border-b border-border">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-6">
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
            <div className="h-10 w-3/4 bg-muted rounded animate-pulse" />
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="h-5 bg-muted rounded animate-pulse"
                  style={{ width: `${70 + i * 5}%` }}
                />
              ))}
            </div>
          </div>
          <div className="h-[360px] bg-muted rounded-2xl animate-pulse" />
        </div>
      </div>
    </section>
  );
}

export function FeaturedExpertsSkeleton() {
  return (
    <section className="py-20 md:py-28 bg-background border-b border-border">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="mb-12 space-y-3">
          <div className="h-4 w-28 bg-muted rounded animate-pulse" />
          <div className="h-9 w-72 bg-muted rounded animate-pulse" />
          <div className="h-5 w-96 max-w-full bg-muted rounded animate-pulse" />
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-[260px] bg-muted/50 border border-border rounded-2xl animate-pulse"
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function TestimonialsSkeleton() {
  return (
    <section className="py-20 md:py-28 bg-zinc-950">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="mb-12 space-y-3">
          <div className="h-4 w-36 bg-zinc-800 rounded animate-pulse" />
          <div className="h-9 w-72 bg-zinc-800 rounded animate-pulse" />
          <div className="h-5 w-96 max-w-full bg-zinc-800 rounded animate-pulse" />
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-[220px] bg-zinc-900 border border-white/[0.08] rounded-2xl animate-pulse"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
