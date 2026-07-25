import { Skeleton } from "@/components/ui/skeleton";

export default function HelpLoading() {
  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6">
      {/* Simulate Header */}
      <div className="mb-8">
        <Skeleton className="h-4 w-1/4 mb-4 rounded" />{" "}
        {/* Breadcrumb/Category */}
        <Skeleton className="h-10 w-3/4 mb-6 rounded-lg" /> {/* Main Title */}
        <Skeleton className="h-10 w-full max-w-md rounded-md" />{" "}
        {/* Search Input */}
      </div>

      {/* Simulate Accordion Items */}
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="border-b border-zinc-200 py-4">
            <Skeleton className="h-6 w-full rounded" />{" "}
            {/* Accordion Trigger/Question */}
            {/* Accordion content is usually hidden by default, so not explicitly skeletonized unless open */}
          </div>
        ))}
      </div>
    </div>
  );
}
