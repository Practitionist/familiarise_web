import { Skeleton } from "@/components/ui/skeleton";

export function AppointmentCardSkeleton() {
  return (
    <div className="bg-gray-100 p-4 rounded-lg">
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-full" />
        <div className="flex-1 min-w-0">
          <Skeleton className="h-4 w-24 mb-2" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <div className="mt-3">
        <Skeleton className="h-3 w-20 mb-2" />
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
    </div>
  );
}

export function AppointmentListSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(3)].map((_, index) => (
        <div key={index} className="border rounded-lg overflow-hidden">
          <div className="bg-gray-50 p-3 border-b">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <Skeleton className="w-8 h-8 rounded-full" />
                <div>
                  <Skeleton className="h-4 w-24 mb-1" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <Skeleton className="h-5 w-16" />
            </div>
          </div>
          <div className="divide-y divide-gray-100">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 p-3">
                <Skeleton className="w-8 h-8 rounded-full" />
                <div className="flex-grow space-y-1">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <div className="flex items-center space-x-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-6 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ClientActivitySkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(4)].map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="w-8 h-8 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-3 w-24 mb-1" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export function TodayAppointmentsSkeleton() {
  return (
    <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
      <div className="flex items-center gap-2 mb-3 lg:mb-4">
        <Skeleton className="h-6 w-6" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:gap-4">
        {[...Array(4)].map((_, index) => (
          <AppointmentCardSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

export function UpcomingAppointmentsSkeleton() {
  return (
    <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
      <div className="flex items-center gap-2 mb-3 lg:mb-4">
        <Skeleton className="h-6 w-6" />
        <Skeleton className="h-6 w-40" />
      </div>
      <AppointmentListSkeleton />
    </div>
  );
}

export function ClientActivityCardSkeleton() {
  return (
    <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
      <div className="flex items-center gap-2 mb-3 lg:mb-4">
        <Skeleton className="h-6 w-6" />
        <Skeleton className="h-6 w-28" />
      </div>
      <ClientActivitySkeleton />
      <Skeleton className="mt-3 lg:mt-4 h-10 w-full" />
    </div>
  );
}

export function PendingApprovalsSkeleton() {
  return (
    <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
      <div className="flex items-center gap-2 mb-3 lg:mb-4">
        <Skeleton className="h-6 w-6" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="max-h-[300px] overflow-auto">
        <div className="space-y-2">
          {[...Array(3)].map((_, index) => (
            <div key={index} className="p-3 border rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Skeleton className="w-8 h-8 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-24 mb-1" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-6 w-16" />
                  <Skeleton className="h-6 w-16" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DashboardHomeSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
      <div className="lg:col-span-2 space-y-4 lg:space-y-6">
        <TodayAppointmentsSkeleton />
        <UpcomingAppointmentsSkeleton />
      </div>
      <div className="space-y-4 lg:space-y-6">
        <ClientActivityCardSkeleton />
        <PendingApprovalsSkeleton />
      </div>
    </div>
  );
}

export function ConsulteeWelcomeSkeleton() {
  return (
    <div className="bg-white rounded-xl p-6">
      <Skeleton className="h-8 w-48 mb-2" />
      <Skeleton className="h-4 w-64" />
    </div>
  );
}

export function UpcomingSectionSkeleton() {
  return (
    <div className="bg-white rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="h-6 w-6" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[...Array(4)].map((_, index) => (
          <div key={index} className="border rounded-lg p-4">
            <div className="flex items-center gap-3 mb-3">
              <Skeleton className="w-10 h-10 rounded-full" />
              <div>
                <Skeleton className="h-4 w-24 mb-1" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthlySectionSkeleton() {
  return (
    <div className="bg-white rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-6 w-32" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
        </div>
      </div>
      <div className="grid grid-cols-7 gap-2 mb-4">
        {[...Array(7)].map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {[...Array(35)].map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function ConsulteeDashboardSkeleton() {
  return (
    <div className="space-y-6 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      <ConsulteeWelcomeSkeleton />
      <UpcomingSectionSkeleton />
      <MonthlySectionSkeleton />
    </div>
  );
}
