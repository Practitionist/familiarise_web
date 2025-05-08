import { Skeleton } from "@/components/ui/skeleton";

export default function ChatsLoading() {
  return (
    <div className="flex h-[calc(100vh-theme(spacing.16))] overflow-hidden">
      {/* Sidebar Skeleton */}
      <div className="w-1/4 border-r p-4 space-y-3">
        <Skeleton className="h-8 w-full rounded-md" />
        {[...Array(8)].map((_, i) => (
          <div key={i} className="flex items-center space-x-3 p-2">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-3/4 rounded" />
              <Skeleton className="h-3 w-1/2 rounded" />
            </div>
          </div>
        ))}
      </div>

      {/* Main Chat Area Skeleton */}
      <div className="flex-1 flex flex-col">
        {/* Chat Header Skeleton */}
        <div className="border-b p-4 flex items-center space-x-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-5 w-1/3 rounded" />
        </div>

        {/* Chat Messages Skeleton */}
        <div className="flex-1 p-4 space-y-4 overflow-y-auto">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-start space-x-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-48 rounded" />
                <Skeleton className="h-3 w-32 rounded" />
              </div>
            </div>
          ))}
          {[...Array(2)].map((_, i) => (
            <div
              key={`rtl-${i}`}
              className="flex items-start justify-end space-x-3"
            >
              <div className="space-y-1 text-right">
                <Skeleton className="h-4 w-40 rounded ml-auto" />
                <Skeleton className="h-3 w-24 rounded ml-auto" />
              </div>
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          ))}
        </div>

        {/* Message Input Skeleton */}
        <div className="border-t p-4">
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
