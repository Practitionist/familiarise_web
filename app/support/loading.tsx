import { Skeleton } from "@/components/ui/skeleton";

export default function SupportLoading() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        <div className="flex gap-10">
          <div className="hidden w-64 shrink-0 lg:block xl:w-72">
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-lg" />
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <Skeleton className="h-12 w-3/4 max-w-xl" />
            <Skeleton className="mt-3 h-5 w-1/2 max-w-md" />
            <Skeleton className="mt-8 h-14 w-full max-w-xl rounded-full" />
            <div className="mt-10 space-y-0">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-none border-b" />
              ))}
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-2xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
