export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-2xl space-y-6 rounded-2xl p-8">
        <div className="mx-auto h-16 w-16 animate-pulse rounded-full bg-muted" />
        <div className="mx-auto h-6 w-48 animate-pulse rounded-md bg-muted" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-4 w-full animate-pulse rounded-md bg-muted" />
          ))}
        </div>
        <div className="flex gap-4">
          <div className="h-10 flex-1 animate-pulse rounded-md bg-muted" />
          <div className="h-10 flex-1 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
    </div>
  );
}
