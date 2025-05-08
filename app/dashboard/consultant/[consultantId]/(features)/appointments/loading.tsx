import { Skeleton } from "@/components/ui/skeleton";

export default function AppointmentsLoading() {
  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-6">
      {/* Simulate the main title */}
      <Skeleton className="h-7 w-1/3 rounded-lg mb-4" />

      {/* Simulate a grouped appointment section */}
      {[...Array(2)].map((_, groupIndex) => (
        <div key={groupIndex} className="border rounded-lg overflow-hidden">
          {/* Simulate Group Header */}
          <div className="bg-gray-50 p-4 border-b">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Skeleton className="h-10 w-10 rounded-full" /> {/* Avatar */}
                <div className="space-y-1">
                  <Skeleton className="h-5 w-32 rounded" /> {/* Name */}
                  <Skeleton className="h-4 w-48 rounded" /> {/* Group Title */}
                </div>
              </div>
              <Skeleton className="h-6 w-24 rounded-md" /> {/* Badge */}
            </div>
          </div>

          {/* Simulate Appointments List in the group */}
          <ul className="divide-y">
            {[...Array(2)].map((_, itemIndex) => (
              <li
                key={itemIndex}
                className="flex items-center justify-between p-4 hover:bg-gray-50"
              >
                <div className="flex items-center space-x-4">
                  {/* For non-recurring, avatar is shown per item, let's simulate one style for loading */}
                  {/* <Skeleton className="h-10 w-10 rounded-full" /> */}
                  <div className="space-y-1">
                    <Skeleton className="h-5 w-40 rounded" /> {/* Name / Type */}
                    <Skeleton className="h-4 w-56 rounded" /> {/* Type / Plan / Time */}
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Skeleton className="h-6 w-24 rounded-md" /> {/* Badge */}
                  <Skeleton className="h-9 w-28 rounded-md" /> {/* Button */}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {/* Simulate the 'No Appointments Found' state if it were empty (optional, for structure) */}
      {/* <div className="flex flex-col items-center justify-center min-h-[200px] p-8 bg-gray-50 rounded-lg">
        <Skeleton className="h-16 w-16 rounded-full mb-4" />
        <Skeleton className="h-6 w-1/2 rounded mb-2" />
        <Skeleton className="h-4 w-3/4 rounded" />
      </div> */}
    </div>
  );
} 