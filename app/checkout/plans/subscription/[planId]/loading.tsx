export default function Loading() {
  return (
    <>
      <div className="flex flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-5 w-40 animate-pulse rounded-md bg-muted" />
            <div className="h-4 w-28 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-4 w-full animate-pulse rounded-md bg-muted"
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-8 bg-card p-6 sm:p-8">
        <div className="h-48 animate-pulse rounded-xl bg-muted" />
        <div className="space-y-4">
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    </>
  );
}
