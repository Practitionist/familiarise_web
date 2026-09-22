import { Skeleton } from "@/components/ui/skeleton";

export default function SupportLoading() {
  return (
    <section className="w-full">
      <div className="border-b border-border bg-muted/40">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16 text-center">
          <Skeleton className="mx-auto h-14 w-14 rounded-2xl" />
          <Skeleton className="mx-auto mt-4 h-10 w-64" />
          <Skeleton className="mx-auto mt-3 h-5 w-96 max-w-full" />
          <Skeleton className="mx-auto mt-8 h-14 w-full max-w-2xl rounded-full" />
        </div>
      </div>
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      </div>
    </section>
  );
}
