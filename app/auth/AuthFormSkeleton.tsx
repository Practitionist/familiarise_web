/** The form column only, for fallbacks rendered beside the server side panel. */
export function AuthFormColumnSkeleton() {
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center bg-neutral-950 p-8 md:w-1/2">
      <div className="w-full max-w-md space-y-6">
        <div className="h-8 w-32 animate-pulse rounded-md bg-muted" />
        <div className="space-y-3">
          <div className="h-10 animate-pulse rounded-md bg-muted" />
          <div className="h-10 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="h-10 animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}

/** Shared split-panel auth chrome — matches signin/signup loading.tsx anatomy. */
export function AuthFormSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden animate-pulse bg-muted md:block md:w-1/2" />
      <AuthFormColumnSkeleton />
    </div>
  );
}
