"use client";

import { getEffectiveUserId } from "@/utils/auth";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Skeleton } from "components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { usePrefetchDashboard } from "@/hooks/useCosultantPrefetchDashboard";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConsultantData } from "./utils/fetchHelpers";
import {
  LayoutDashboard,
  MessageCircle,
  Calendar,
  ClipboardList,
  FileText,
  FileCheck,
  HelpCircle,
  Settings,
  LogOut,
  User,
  ChevronDown,
} from "lucide-react";

// Navigation configuration
const NAV_ITEMS = [
  { name: "Dashboard", path: "home", icon: LayoutDashboard },
  { name: "Chats", path: "chats", icon: MessageCircle },
  { name: "Appointments", path: "appointments", icon: Calendar },
  { name: "Event Planner", path: "planner", icon: ClipboardList },
  { name: "Requests", path: "requests", icon: FileText },
  { name: "Documents", path: "documents", icon: FileCheck },
  { name: "Help & Support", path: "help", icon: HelpCircle },
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
  const router = useRouter();
  const queryClient = useQueryClient();

  const userId = getEffectiveUserId(session);
  const { prefetchOnTabHover, prefetchAllConsultantData } =
    usePrefetchDashboard({ consultantId });

  // Replace SWR with React Query
  const {
    data: consultantData,
    error,
    isLoading,
  } = useQuery({
    queryKey: [`consultant-${consultantId}`, consultantId],
    queryFn: () => fetchConsultantData(consultantId),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes (formerly cacheTime)
    retry: 2,
  });

  // Enhanced prefetching strategy
  useEffect(() => {
    if (!userId || !consultantId) return;

    // Immediate prefetch of critical data
    const prefetchCriticalData = async () => {
      // Prefetch all dashboard data in background
      prefetchAllConsultantData();

      // Prefetch routes that are likely to be visited
      const criticalRoutes = [
        `/dashboard/consultant/${consultantId}/home`,
        `/dashboard/consultant/${consultantId}/appointments`,
        `/dashboard/consultant/${consultantId}/chats`,
      ];

      // Use Next.js router.prefetch for route-level prefetching
      criticalRoutes.forEach((route) => {
        router.prefetch(route);
      });
    };

    // Use requestIdleCallback for non-blocking prefetch
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      window.requestIdleCallback(prefetchCriticalData);
    } else {
      setTimeout(prefetchCriticalData, 100);
    }
  }, [userId, consultantId, prefetchAllConsultantData, router]);

  // Smart hover prefetching with route prefetching
  const handleNavHover = (path: string) => {
    // Prefetch the route
    router.prefetch(`/dashboard/consultant/${consultantId}/${path}`);

    // Prefetch data for specific tabs
    if (path === "home") {
      prefetchOnTabHover("home");
    } else if (path === "appointments") {
      prefetchOnTabHover("appointments");
    } else if (path === "planner") {
      prefetchOnTabHover("planner");
    } else if (path === "requests") {
      prefetchOnTabHover("requests");
    }
  };

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
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 fixed left-0 top-0 h-screen flex flex-col">
        {/* Branding Section */}
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <h1 className="text-xl font-bold text-gray-900">Familiarise</h1>
        </div>

        {/* Profile Section */}
        <div className="px-6 py-4 border-b border-gray-200 flex-shrink-0">
          {isLoading ? (
            <div className="flex items-center space-x-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-[120px]" />
                <Skeleton className="h-3 w-[80px]" />
              </div>
            </div>
          ) : (
            <div className="flex items-center space-x-3">
              <Avatar className="h-10 w-10">
                <AvatarImage
                  src={consultantData?.user.image || "/placeholder.svg"}
                  alt={consultantData?.user.name || ""}
                />
                <AvatarFallback className="bg-gray-200 text-gray-700">
                  {consultantData?.user.name?.charAt(0) || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <h2 className="font-medium text-sm text-gray-900 truncate">
                  {consultantData?.user.name}
                </h2>
                <p className="text-xs text-gray-500 truncate">
                  {consultantData?.specialization || "Consultant"}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation - Scrollable */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.path}>
                  <Link
                    href={`/dashboard/consultant/${consultantId}/${item.path}`}
                    className={`flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium ${
                      currentPath === item.path
                        ? "bg-gray-100 text-gray-900"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                    prefetch={true}
                    onMouseEnter={() => handleNavHover(item.path)}
                  >
                    <Icon
                      size={20}
                      className={
                        currentPath === item.path
                          ? "text-gray-900"
                          : "text-gray-500"
                      }
                    />
                    <span>{item.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Bottom Navigation - Sticky at Bottom */}
        <div className="border-t border-gray-200 bg-white px-3 py-3 flex-shrink-0">
          <div className="space-y-1">
            <Link
              href={`/dashboard/consultant/${consultantId}/settings`}
              className={`flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium ${
                currentPath === "settings"
                  ? "bg-gray-100 text-gray-900"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
              prefetch={true}
              onMouseEnter={() =>
                router.prefetch(
                  `/dashboard/consultant/${consultantId}/settings`,
                )
              }
            >
              <Settings
                size={20}
                className={
                  currentPath === "settings" ? "text-gray-900" : "text-gray-500"
                }
              />
              <span>Settings</span>
            </Link>
            <button
              onClick={() => signOut()}
              className="flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium w-full text-gray-600 hover:bg-gray-50"
            >
              <LogOut size={20} className="text-gray-500" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 ml-64 p-8 overflow-auto">
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
