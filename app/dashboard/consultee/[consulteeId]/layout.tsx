"use client";

import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
import { getEffectiveUserId } from "@/utils/auth";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import StreamProvider from "@/providers/StreamProvider";
import { DashboardSidebar, type NavItem } from "@/components/dashboard";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserProvider } from "./UserContext";
import { motion } from "framer-motion";
import { schedulePrefetch } from "@/lib/dashboard-queries";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import {
  Home,
  Calendar,
  History,
  MessageSquare,
  Ticket,
  Settings,
  Shield,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

// Navigation configuration
const NAV_ITEMS: NavItem[] = [
  { name: "Home", path: "home" },
  { name: "Appointments", path: "appointments" },
  { name: "History", path: "history" },
  { name: "Messages", path: "messages" },
  { name: "Support", path: "feedback" },
  { name: "Settings", path: "settings" },
  { name: "Policy", path: "policy" },
];

// Icon mapping
const iconMap: Record<string, typeof Home> = {
  home: Home,
  appointments: Calendar,
  history: History,
  messages: MessageSquare,
  feedback: Ticket,
  settings: Settings,
  policy: Shield,
};

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}

// Error display
function ErrorDisplay({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <svg
            className="w-8 h-8 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-zinc-900 mb-2">
          Something went wrong
        </h2>
        <p className="text-zinc-600">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Try Again
        </button>
      </motion.div>
    </div>
  );
}

// Auth required
function AuthRequired() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
          <svg
            className="w-8 h-8 text-amber-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-zinc-900 mb-2">
          Authentication Required
        </h2>
        <p className="text-zinc-600">
          Please sign in to access your dashboard.
        </p>
        <a
          href="/auth/signin"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Sign In
        </a>
      </motion.div>
    </div>
  );
}

// Modern top navigation for consultee
function ConsulteeNav({
  consulteeId,
  currentPath,
  userName,
  userImage,
  isLoading,
}: {
  consulteeId: string;
  currentPath: string | undefined;
  userName?: string | null;
  userImage?: string | null;
  isLoading: boolean;
}) {
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleNavHover = (path: string) => {
    router.prefetch(`/dashboard/consultee/${consulteeId}/${path}`);
  };

  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-zinc-200/50">
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center">
          {/* Logo - Left */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-zinc-900 flex items-center justify-center">
              <span className="text-white font-bold text-sm">F</span>
            </div>
            <span className="font-semibold text-zinc-900 hidden sm:block">
              Familiarise
            </span>
          </Link>

          {/* Desktop Navigation - Center */}
          <nav className="hidden lg:flex items-center justify-center flex-1 gap-1">
            {NAV_ITEMS.map((item) => {
              const isActive = currentPath === item.path;
              const Icon = iconMap[item.path];

              return (
                <Link
                  key={item.path}
                  href={`/dashboard/consultee/${consulteeId}/${item.path}`}
                  className={cn(
                    "px-3 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap",
                    isActive
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                  )}
                  prefetch={true}
                  onMouseEnter={() => handleNavHover(item.path)}
                >
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* User Section - Right */}
          <div className="flex items-center gap-3 shrink-0 ml-auto lg:ml-0">
            {isLoading ? (
              <Skeleton className="h-10 w-10 rounded-full" />
            ) : (
              <div className="flex items-center gap-3">
                <span className="hidden xl:block text-sm text-zinc-600">
                  Welcome,{" "}
                  <span className="font-medium text-zinc-900">
                    {userName?.split(" ")[0]}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => signOut()}
                  className="text-zinc-500 hover:text-red-600"
                >
                  <LogOut className="w-4 h-4" />
                </Button>
                <Link href="/profile">
                  <Avatar className="h-9 w-9 ring-2 ring-zinc-100 hover:ring-zinc-300 transition-all cursor-pointer">
                    <AvatarImage
                      src={userImage || "/placeholder-user.jpg"}
                      alt={userName || ""}
                    />
                    <AvatarFallback className="bg-zinc-100 text-zinc-600">
                      {userName?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                </Link>
              </div>
            )}

            {/* Mobile menu button */}
            <button
              className="lg:hidden p-2 rounded-lg hover:bg-zinc-100"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5 text-zinc-600" />
              ) : (
                <Menu className="w-5 h-5 text-zinc-600" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <motion.nav
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="lg:hidden py-4 border-t border-zinc-100"
          >
            <div className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => {
                const isActive = currentPath === item.path;
                const Icon = iconMap[item.path];

                return (
                  <Link
                    key={item.path}
                    href={`/dashboard/consultee/${consulteeId}/${item.path}`}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all",
                      isActive
                        ? "bg-zinc-900 text-white"
                        : "text-zinc-600 hover:bg-zinc-100",
                    )}
                    prefetch={true}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {Icon && <Icon className="w-5 h-5" />}
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </motion.nav>
        )}
      </div>
    </header>
  );
}

// Loading skeleton
function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header skeleton */}
      <header className="sticky top-0 z-50 bg-white border-b border-zinc-200">
        <div className="w-full px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center">
            <Skeleton className="h-8 w-32 shrink-0" />
            <div className="hidden lg:flex items-center justify-center flex-1 gap-2">
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Skeleton key={i} className="h-9 w-24 rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-10 w-10 rounded-full shrink-0 ml-auto lg:ml-0" />
          </div>
        </div>
      </header>

      {/* Content skeleton */}
      <main className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 py-8">
        <div className="space-y-6">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </main>
    </div>
  );
}

// Main layout
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

  const userId = getEffectiveUserId(session);

  // Fetch user details with placeholderData to prevent loading flashes
  const {
    data: userDetails,
    error: userError,
    isLoading: isLoadingUser,
  } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId!),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData, // Keep showing previous data while refetching
  });

  // Fetch consultee profile with placeholderData to prevent loading flashes
  const {
    data: profileDetails,
    error: profileError,
    isLoading: isLoadingProfile,
  } = useQuery({
    queryKey: ["consultee-profile", consulteeId],
    queryFn: () => fetchConsulteeDetails(consulteeId),
    enabled: !!consulteeId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData, // Keep showing previous data while refetching
  });

  // Prefetch
  useEffect(() => {
    if (!userId || !consulteeId) return;

    schedulePrefetch(() => {
      if (!pathname.includes("/home")) {
        router.prefetch(`/dashboard/consultee/${consulteeId}/home`);
      }
    }, 3000);
  }, [userId, consulteeId, pathname, router]);

  const isLoading = isLoadingUser || isLoadingProfile;
  const error = (userError || profileError) as Error | null;

  // Memoize StreamProvider children to prevent re-initialization on tab switches
  // Must be called before any early returns to comply with Rules of Hooks
  const memoizedStreamContent = useMemo(
    () =>
      userDetails?.id ? (
        <StreamProvider
          userId={userDetails.id}
          enableChat={true}
          enableVideo={true}
        >
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </StreamProvider>
      ) : (
        <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
      ),
    [userDetails?.id, children],
  );

  // Auth check
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test" &&
    !session?.user?.id
  ) {
    return <AuthRequired />;
  }

  // Initial loading
  if (!userDetails && isLoading) {
    return <DashboardSkeleton />;
  }

  // Error state
  if (error) {
    return (
      <ErrorDisplay message={error.message || "Failed to load dashboard"} />
    );
  }

  if (!userDetails) {
    return <DashboardSkeleton />;
  }

  return (
    <UserProvider userDetails={userDetails}>
      <div className="min-h-screen bg-zinc-50">
        <ConsulteeNav
          consulteeId={consulteeId}
          currentPath={currentPath}
          userName={userDetails.name}
          userImage={userDetails.image}
          isLoading={isLoading}
        />

        <main className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 py-6 lg:py-8">
          {memoizedStreamContent}
        </main>
      </div>
    </UserProvider>
  );
}
