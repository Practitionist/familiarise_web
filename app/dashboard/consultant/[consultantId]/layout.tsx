"use client";

import { getEffectiveUserId } from "@/utils/auth";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Skeleton } from "components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { usePrefetchDashboard } from "@/hooks/usePrefetchDashboard";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useEffect } from "react";
import useSWR, { preload } from "swr";
import { fetchConsultantData } from "./utils/fetchHelpers";

// Navigation configuration
const NAV_ITEMS = [
  { name: "Home", path: "home", icon: "🏠" },
  { name: "Chats", path: "chats", icon: "💬" },
  { name: "Appointments", path: "appointments", icon: "📅" },
  { name: "Event Planner", path: "planner", icon: "📋" },
  { name: "Requests", path: "requests", icon: "📝" },
  { name: "Documents for Review", path: "documents", icon: "📄" },
  { name: "Help", path: "help", icon: "❓" },
] as const;

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}

interface MessageContainerProps {
  title: string;
  message: string;
  titleColor?: string;
}

// Reusable components
function MessageContainer({
  title,
  message,
  titleColor = "text-red-600",
}: Readonly<MessageContainerProps>) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
        <h2 className={`text-xl sm:text-2xl font-bold ${titleColor} mb-4`}>
          {title}
        </h2>
        <p className="text-gray-700">{message}</p>
      </div>
    </div>
  );
}

// Main layout component
export default function ConsultantLayout({
  children,
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;
  const pathname = usePathname();
  const currentPath = pathname.split("/").pop();
  const { data: session } = useSession();

  const userId = getEffectiveUserId(session);
  const { prefetchOnTabHover, prefetchAllConsultantData } =
    usePrefetchDashboard({ consultantId });

  // Use SWR to fetch and cache consultant data
  const { data: consultantData, error } = useSWR(
    userId ? [`consultant-${consultantId}`, consultantId] : null,
    ([_, id]) => fetchConsultantData(id),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      dedupingInterval: 300000, // 5 minutes
    },
  );

  // Enhanced prefetching for all dashboard tabs in background
  useEffect(() => {
    // If we have userId and consultantId, prefetch all dashboard data
    if (userId && consultantId) {
      // Prefetch consultant data for immediate needs
      preload([`consultant-${consultantId}`, consultantId], ([_, id]) =>
        fetchConsultantData(id),
      );

      // Prefetch all other dashboard tabs in background for instant navigation
      prefetchAllConsultantData();
    }
  }, [userId, consultantId, prefetchAllConsultantData]);

  // Early render of the skeleton UI for better perceived performance
  const isLoading = !consultantData && !error;

  // Authentication check
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test" &&
    !session?.user?.id
  ) {
    return (
      <MessageContainer
        title="Authentication Required"
        message="Please sign in to access your dashboard."
      />
    );
  }

  // Main layout - Note we always render the layout even during loading
  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r relative min-h-screen flex flex-col">
        {/* Profile Section */}
        <div className="p-4 border-b">
          {isLoading ? (
            <div className="flex items-center space-x-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-[150px]" />
                <Skeleton className="h-4 w-[100px]" />
              </div>
            </div>
          ) : (
            <div className="flex items-center space-x-3">
              <Avatar className="h-12 w-12">
                <AvatarImage
                  src={consultantData?.user.image || "/placeholder.svg"}
                  alt={consultantData?.user.name || ""}
                />
                <AvatarFallback>
                  {consultantData?.user.name?.charAt(0) || "?"}
                </AvatarFallback>
              </Avatar>
              <div>
                <h2 className="font-semibold">{consultantData?.user.name}</h2>
                <p className="text-sm text-gray-500">CONSULTANT</p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="p-4 flex-grow">
          <ul className="space-y-2">
            {NAV_ITEMS.map((item) => (
              <li key={item.path}>
                <Link
                  href={`/dashboard/consultant/${consultantId}/${item.path}`}
                  className={`flex items-center space-x-2 p-2 rounded-md transition-colors ${
                    currentPath === item.path
                      ? "bg-blue-50 text-blue-600"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                  prefetch={true}
                  onMouseEnter={() => {
                    // Prefetch data when hovering over navigation items
                    if (item.path === "home") {
                      prefetchOnTabHover("home");
                    } else if (item.path === "appointments") {
                      prefetchOnTabHover("appointments");
                    } else {
                      prefetchOnTabHover("other");
                    }
                  }}
                >
                  <span>{item.icon}</span>
                  <span>{item.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Bottom Navigation */}
        <div className="border-t bg-white mt-auto">
          <Link
            href="/"
            className="flex items-center space-x-2 p-4 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <span>⬅️</span>
            <span>Back</span>
          </Link>
          <Link
            href={`/dashboard/consultant/${consultantId}/settings`}
            className={`flex items-center space-x-2 p-4 transition-colors ${
              currentPath === "settings"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-600 hover:bg-gray-100"
            }`}
            prefetch={true}
          >
            <span>⚙️</span>
            <span>Settings</span>
          </Link>
          <button
            onClick={() => signOut()}
            className="flex items-center space-x-2 p-4 w-full text-red-600 hover:bg-red-50 transition-colors"
          >
            <span>🚪</span>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-auto">
        {error ? (
          // Display error within the main content area
          <div className="flex items-center justify-center h-full">
            <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
              <h2 className={`text-xl sm:text-2xl font-bold text-red-600 mb-4`}>
                Error
              </h2>
              <p className="text-gray-700">
                {error instanceof Error
                  ? error.message
                  : "An unknown error occurred"}
              </p>
            </div>
          </div>
        ) : isLoading ? (
          // Show a loading UI in the main content while data is loading
          <div className="flex flex-col space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-32 w-full rounded-md" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Skeleton className="h-24 rounded-md" />
              <Skeleton className="h-24 rounded-md" />
            </div>
          </div>
        ) : (
          // Render children when data is loaded and no error with error boundary
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        )}
      </main>
    </div>
  );
}
