"use client";

import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
import { getEffectiveUserId } from "@/utils/auth";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Button } from "components/ui/button";
import { Skeleton } from "components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import StreamProvider from "@/providers/StreamProvider";
// Removed aggressive prefetching import - using lightweight approach instead
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  onNavHover: (path: string) => void;
  isLoadingProfile?: boolean;
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
  onNavHover,
  isLoadingProfile = false,
}: Readonly<ConsulteeNavProps>) {
  const firstName = userName?.split(" ")[0] || "User";

  return (
    <nav className="p-4 sm:p-8 bg-white shadow-sm">
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.name}
              href={`/dashboard/consultee/${consulteeId}/${item.path}`}
              prefetch={true}
              onMouseEnter={() => onNavHover(item.path)}
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
          {isLoadingProfile ? (
            <Skeleton className="hidden md:block h-5 w-36" />
          ) : (
            <div className="hidden md:block">
              <p className="text-sm font-medium text-gray-700">
                Welcome, {firstName}
              </p>
            </div>
          )}

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
            {isLoadingProfile ? (
              <Skeleton className="h-10 w-10 rounded-full" />
            ) : (
              <Avatar className="h-10 w-10 cursor-pointer hover:ring-2 hover:ring-offset-2 hover:ring-blue-400 transition-all">
                <AvatarImage
                  src={userImage || "/placeholder.svg"}
                  alt={userName || "User Profile"}
                />
                <AvatarFallback>{userName?.charAt(0) || "U"}</AvatarFallback>
              </Avatar>
            )}
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
  const router = useRouter();
  const queryClient = useQueryClient();

  const userId = getEffectiveUserId(session);

  // Replace SWR with React Query for user details
  const {
    data: userDetails,
    error: userError,
    isLoading: isLoadingUser,
  } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId!),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  // Replace SWR with React Query for consultee details
  const {
    data: profileDetails,
    error: profileError,
    isLoading: isLoadingProfile,
  } = useQuery({
    queryKey: ["consultee-profile", consulteeId],
    queryFn: () => fetchConsulteeDetails(consulteeId),
    enabled: !!consulteeId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  // Reduced prefetching strategy - only prefetch on user interaction
  useEffect(() => {
    if (!userId || !consulteeId) return;

    // Only prefetch current route and one likely next route after a delay
    const prefetchMinimalData = () => {
      // Prefetch only the current route
      const currentRoute = pathname;
      if (currentRoute) {
        router.prefetch(currentRoute);
      }

      // Prefetch home route only if not already there, after a longer delay
      if (!pathname.includes("/home")) {
        setTimeout(() => {
          router.prefetch(`/dashboard/consultee/${consulteeId}/home`);
        }, 2000);
      }
    };

    // Use requestIdleCallback with longer timeout to reduce blocking
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      window.requestIdleCallback(prefetchMinimalData, { timeout: 5000 });
    } else {
      setTimeout(prefetchMinimalData, 1000);
    }
  }, [userId, consulteeId, pathname, router]);

  // Lightweight hover prefetching - route only
  const handleNavHover = (path: string) => {
    // Only prefetch the route, let the page handle its own data loading
    router.prefetch(`/dashboard/consultee/${consulteeId}/${path}`);
  };

  const isLoading = isLoadingUser || isLoadingProfile;
  const error = (userError || profileError) as Error | null;

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

  // Show loading only for critical user details needed for UserProvider
  if (!userDetails) {
    // Only show error if there's an actual error, otherwise render layout with skeleton
    if (userError || profileError) {
      return (
        <MessageContainer
          title="Error"
          message={
            (userError as Error)?.message ||
            (profileError as Error)?.message ||
            "Failed to load user details"
          }
        />
      );
    }
    // If still loading userDetails, show minimal skeleton but still render layout
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
        <main className="flex-grow overflow-y-auto p-8">
          <div className="space-y-6">
            <Skeleton className="h-12 w-64" />
            <Skeleton className="h-40 w-full rounded-lg" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Skeleton className="h-32 rounded-lg" />
              <Skeleton className="h-32 rounded-lg" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Determine the appropriate display name - prefer consultee profile name if available
  const displayName = profileDetails?.user?.name || userDetails.name;
  const displayImage = profileDetails?.user?.image || userDetails.image;

  // Main layout
  return (
    <UserProvider userDetails={userDetails}>
      <div className="bg-slate-50 min-h-screen flex flex-col">
        <ConsulteeNav
          consulteeId={consulteeId}
          currentPath={currentPath}
          userImage={displayImage}
          userName={displayName}
          onNavHover={handleNavHover}
          isLoadingProfile={isLoadingProfile}
        />
        <main className={`flex-grow overflow-y-auto ${currentPath === 'messages' ? '' : 'p-8'}`}>
          <StreamProvider
            userId={userDetails.id}
            enableChat={true}
            enableVideo={true}
          >
            <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
          </StreamProvider>
        </main>
      </div>
    </UserProvider>
  );
}
