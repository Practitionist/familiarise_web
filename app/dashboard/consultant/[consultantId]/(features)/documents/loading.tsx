import { Skeleton } from "@/components/ui/skeleton";

export default function DocumentsLoading() {
  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-6">
      {/* Simulate the main title */}
      <Skeleton className="h-7 w-1/3 rounded-lg" />

      {/* Simulate the Table structure */}
      <div className="overflow-auto">
        <div className="w-full space-y-3">
          {/* Simulate TableHeader */}
          <div className="flex space-x-4 p-2 border-b">
            <Skeleton className="h-5 flex-1 rounded" /> {/* Invoice No. */}
            <Skeleton className="h-5 flex-1 rounded" /> {/* Title */}
            <Skeleton className="h-5 flex-1 rounded" /> {/* Client Name */}
            <Skeleton className="h-5 w-24 rounded" /> {/* Tag */}
            <Skeleton className="h-5 w-32 rounded" /> {/* Action */}
          </div>

          {/* Simulate TableBody with a few rows */}
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="flex space-x-4 p-3 border-b last:border-b-0"
            >
              <Skeleton className="h-5 flex-1 rounded" />
              <Skeleton className="h-5 flex-1 rounded" />
              <Skeleton className="h-5 flex-1 rounded" />
              <Skeleton className="h-6 w-20 rounded-md" /> {/* Badge */}
              <div className="flex space-x-2 w-32">
                <Skeleton className="h-8 w-1/2 rounded" /> {/* Review Button */}
                <Skeleton className="h-8 w-1/2 rounded" />{" "}
                {/* Download Button */}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
