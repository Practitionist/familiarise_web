export default function Loading() {
  return (
    <div
      className="container mx-auto max-w-5xl px-4 py-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]"
      aria-hidden
    >
      <div className="space-y-6">
        <div className="aspect-video rounded-xl bg-muted motion-safe:animate-pulse" />
        <div className="space-y-3">
          <div className="h-4 w-40 bg-muted rounded motion-safe:animate-pulse" />
          <div className="h-8 w-3/4 bg-muted rounded-lg motion-safe:animate-pulse" />
          <div className="h-4 w-full bg-muted rounded motion-safe:animate-pulse" />
          <div className="h-4 w-5/6 bg-muted rounded motion-safe:animate-pulse" />
        </div>
      </div>
      <aside className="space-y-4 h-fit rounded-xl border bg-card p-6 lg:sticky lg:top-24">
        <div className="h-9 w-28 bg-muted rounded-lg motion-safe:animate-pulse" />
        <div className="h-10 w-full bg-muted rounded-lg motion-safe:animate-pulse" />
        <div className="h-3 w-full bg-muted rounded motion-safe:animate-pulse" />
        <div className="h-3 w-4/5 bg-muted rounded motion-safe:animate-pulse" />
      </aside>
    </div>
  );
}
