"use client";

import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
import { getEffectiveUserId } from "@/utils/auth";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Button } from "components/ui/button";
import { Skeleton } from "components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { usePrefetchDashboard } from "@/hooks/usePrefetchDashboard";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useEffect } from "react";
import useSWR, { preload } from "swr";
import { UserProvider } from "./UserContext";

// Navigation configuration
const NAV_ITEMS = [
  { name: "Home", path: "home" },
  { name: "Appointments", path: "appointments" },
  { name: "Booking History", path: "history" },
  { name: "Messages", path: "messages" },
  { name: "Feedback & Support", path: "feedback" },
  { name: "Settings", path: "settings" },
  { name: "Policy", path: "policy" },
] as const;

// Types
type NavItem = (typeof NAV_ITEMS)[number];

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}

interface MessageContainerProps {
  title: string;
  message: string;
  titleColor?: string;
}

interface ConsulteeNavProps {
  consulteeId: string;
  currentPath: string | undefined;
  userImage?: string | null;
  userName?: string | null;
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

function ConsulteeNav({
  consulteeId,
  currentPath,
  userImage,
  userName,
}: Readonly<ConsulteeNavProps>) {
  const firstName = userName?.split(" ")[0] || "User";
  const { prefetchOnTabHover } = usePrefetchDashboard({ consulteeId });

  return (
    <nav className="p-4 sm:p-8 bg-white shadow-sm">
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.name}
              href={`/dashboard/consultee/${consulteeId}/${item.path}`}
              prefetch={true}
              onMouseEnter={() => {
                // Prefetch data when hovering over navigation items
                if (item.path === 'home') {
                  prefetchOnTabHover('home');
                } else if (item.path === 'appointments') {
                  prefetchOnTabHover('appointments');
                } else {
                  prefetchOnTabHover('other');
                }
              }}
            >
              <Button
                className={`${
                  currentPath === item.path
                    ? "bg-[#f87171] text-white"
                    : "text-gray-600 hover:bg-gray-100 hover:shadow-sm transition-all duration-150 ease-in-out"
                } rounded-md px-4 py-2 transition-colors whitespace-nowrap`}
                variant={currentPath === item.path ? "default" : "ghost"}
              >
                {item.name}
              </Button>
            </Link>
          ))}
        </div>

        {/* User Profile Section */}
        <div className="flex items-center gap-3">
          {/* Welcome Message */}
          <div className="hidden md:block">
            <p className="text-sm font-medium text-gray-700">
              Welcome, {firstName}
            </p>
          </div>

          {/* Sign Out Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut()}
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            Sign Out
          </Button>

          {/* User Profile Avatar */}
          <Link href="/profile">
            <Avatar className="h-10 w-10 cursor-pointer hover:ring-2 hover:ring-offset-2 hover:ring-blue-400 transition-all">
              <AvatarImage
                src={userImage || "/placeholder.svg"}
                alt={userName || "User Profile"}
              />
              <AvatarFallback>{userName?.charAt(0) || "U"}</AvatarFallback>
            </Avatar>
          </Link>
        </div>
      </div>
    </nav>
  );
}

// Main layout component
export default function ConsulteeLayout({
  children,
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;
  const pathname = usePathname();
  const currentPath = pathname.split("/").pop();
  const { data: session } = useSession();

  const userId = getEffectiveUserId(session);
  const { prefetchAllConsulteeData } = usePrefetchDashboard({ consulteeId });

  // Use SWR to fetch user details
  const { data: userDetails, error: userError } = useSWR(
    userId ? [`user-${userId}`, userId] : null,
    ([_, id]) => fetchUserDetails(id),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      dedupingInterval: 300000, // 5 minutes
    },
  );

  // Use SWR to fetch consultee details
  const { data: profileDetails, error: profileError } = useSWR(
    consulteeId ? [`consultee-${consulteeId}`, consulteeId] : null,
    ([_, id]) => fetchConsulteeDetails(id),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      dedupingInterval: 300000, // 5 minutes
    },
  );

  // Enhanced prefetching for all dashboard tabs in background
  useEffect(() => {
    // If we have userId and consulteeId, prefetch all dashboard data
    if (userId && consulteeId) {
      // Prefetch user and consultee data for immediate needs
      preload([`user-${userId}`, userId], ([_, id]) => fetchUserDetails(id));
      preload([`consultee-${consulteeId}`, consulteeId], ([_, id]) =>
        fetchConsulteeDetails(id),
      );
      
      // Prefetch all other dashboard tabs in background for instant navigation
      prefetchAllConsulteeData();
    }
  }, [userId, consulteeId, prefetchAllConsulteeData]);

  const isLoading =
    (!userDetails && !userError) || (!profileDetails && !profileError);
  const error = userError || profileError;

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

  // Error state
  if (error) {
    return (
      <MessageContainer
        title="Error"
        message={
          error instanceof Error ? error.message : "An unknown error occurred"
        }
      />
    );
  }

  // We'll provide a better loading UI instead of a loading message
  if (isLoading) {
    return (
      <div className="bg-slate-50 min-h-screen flex flex-col">
        {/* Skeleton Nav */}
        <div className="p-4 sm:p-8 bg-white shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
              {NAV_ITEMS.map((_, i) => (
                <Skeleton key={i} className="h-10 w-24 sm:w-32 rounded-md" />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Skeleton className="hidden md:block h-5 w-36" />
              <Skeleton className="h-9 w-20" />
              <Skeleton className="h-10 w-10 rounded-full" />
            </div>
          </div>
        </div>

        {/* Skeleton Main Content */}
        <div className="flex-grow overflow-y-auto p-8">
          <div className="space-y-6">
            <Skeleton className="h-12 w-64" />
            <Skeleton className="h-40 w-full rounded-lg" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Ensure userDetails is available since UserProvider expects it
  if (!userDetails) {
    return (
      <MessageContainer title="Error" message="Failed to load user details" />
    );
  }

  // Main layout
  return (
    <UserProvider userDetails={userDetails}>
      <div className="bg-slate-50 min-h-screen flex flex-col">
        <ConsulteeNav
          consulteeId={consulteeId}
          currentPath={currentPath}
          userImage={userDetails.image}
          userName={userDetails.name}
        />
        <main className="flex-grow overflow-y-auto p-8">
          <DashboardErrorBoundary>
            {children}
          </DashboardErrorBoundary>
        </main>
      </div>
    </UserProvider>
  );
}
