import { Skeleton } from "@/components/ui/skeleton"; // Assuming this is the correct path

export default function HomeLoading() {
  return (
    <div className="space-y-6">
      {/* Simulate a title */}
      <Skeleton className="h-8 w-1/2 rounded-lg" />

      {/* Simulate introductory text or stats */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4 rounded" />
        <Skeleton className="h-4 w-5/6 rounded" />
      </div>

      {/* Simulate sections with cards or widgets */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-4">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl md:col-span-2 lg:col-span-1" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}
