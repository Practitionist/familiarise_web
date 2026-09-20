export default function Loading() {
  return (
    <div className="container mx-auto px-4 py-10 space-y-8">
      <header className="space-y-2 text-center">
        <div className="h-9 w-72 bg-muted rounded-lg mx-auto motion-safe:animate-pulse" />
        <div className="h-5 w-96 max-w-full bg-muted rounded-lg mx-auto motion-safe:animate-pulse" />
      </header>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card overflow-hidden"
            aria-hidden
          >
            <div className="aspect-video bg-muted motion-safe:animate-pulse" />
            <div className="p-4 space-y-2">
              <div className="h-4 w-3/4 bg-muted rounded motion-safe:animate-pulse" />
              <div className="h-3 w-1/2 bg-muted rounded motion-safe:animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
