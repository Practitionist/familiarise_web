export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-6 px-4 py-6">
      <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
      <div className="flex items-center gap-4">
        <div className="h-20 w-20 animate-pulse rounded-full bg-muted" />
        <div className="space-y-2">
          <div className="h-6 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-32 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
      <div className="flex gap-6">
        <div className="grid flex-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
        <div className="w-72 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    </div>
  );
}
