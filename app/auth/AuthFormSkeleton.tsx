/** Shared split-panel auth chrome — matches signin/signup loading.tsx anatomy. */
export function AuthFormSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden animate-pulse bg-pearl md:flex md:w-1/2" />
      <div className="flex w-full flex-col items-center justify-center bg-neutral-950 p-8 md:w-1/2">
        <div className="w-full max-w-md space-y-6">
          <div className="h-8 w-32 animate-pulse rounded-md bg-white/10" />
          <div className="space-y-3">
            <div className="h-10 animate-pulse rounded-md bg-white/10" />
            <div className="h-10 animate-pulse rounded-md bg-white/10" />
          </div>
          <div className="h-10 animate-pulse rounded-md bg-white/10" />
        </div>
      </div>
    </div>
  );
}
