"use client";

import { cn } from "@/utils/tailwind";
import {
  CreditCard,
  Home,
  Settings,
  Shield,
  Ticket,
  Users,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Wallet,
  Receipt,
  Star,
  Play,
  LogOut,
  RotateCcw,
  AlertTriangle,
  RefreshCw,
  BarChart3,
  Clock,
  Megaphone,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import NovuProvider from "@/providers/NovuProvider";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { useQuery } from "@tanstack/react-query";
import { fetchUserDetails } from "@/lib/user";
import { getEffectiveUserId } from "@/utils/auth";
import { Skeleton } from "@/components/ui/skeleton";

const sidebarItems = [
  { name: "Home", icon: Home, path: "home" },
  { name: "Announcements", icon: Megaphone, path: "announcements" },
  { name: "Support Tickets", icon: Ticket, path: "tickets" },
  { name: "User Feedback", icon: Star, path: "feedback" },
  { name: "Users", icon: Users, path: "users" },
  { name: "Content Moderation", icon: Shield, path: "moderation" },
  { name: "Appointments", icon: Calendar, path: "appointments" },
  { name: "Waitlists", icon: Clock, path: "waitlists" },
  { name: "Payments", icon: CreditCard, path: "payments" },
  { name: "Payouts", icon: Wallet, path: "payouts" },
  { name: "Invoices", icon: Receipt, path: "invoices" },
  { name: "Refunds", icon: RotateCcw, path: "refunds" },
  { name: "Disputes", icon: AlertTriangle, path: "disputes" },
  { name: "Subscriptions", icon: RefreshCw, path: "subscriptions" },
  { name: "Metrics", icon: BarChart3, path: "metrics" },
  { name: "System Jobs", icon: Play, path: "system-jobs" },
  { name: "Maintenance", icon: Wrench, path: "maintenance" },
  { name: "Settings", icon: Settings, path: "settings" },
];

export default function StaffDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending: isSessionLoading } = useSession();
  const staffId = params.staffId as string;
  const [collapsed, setCollapsed] = useState(false);

  const userId = getEffectiveUserId(session);

  // Fetch user details to check staff access
  const {
    data: userDetails,
    isLoading: isLoadingUser,
    error: userError,
  } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId!),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // Don't block sign-out if disconnect fails
    }
    signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/auth/signin";
        },
      },
    });
  };

  const isActive = (path: string) => {
    return pathname.includes(`/staff/${staffId}/${path}`);
  };

  // Check if user has staff access - must have role ADMIN or STAFF and matching staffProfileId
  const hasStaffAccess =
    userDetails &&
    (userDetails.role === "ADMIN" ||
      userDetails.role === "STAFF" ||
      (userDetails.staffProfileId && userDetails.staffProfileId === staffId));

  // Redirect unauthorized users to their appropriate dashboard
  useEffect(() => {
    if (isLoadingUser || isSessionLoading || !userId) return;

    if (userDetails && !hasStaffAccess) {
      // User doesn't have staff access - redirect based on their role
      if (
        userDetails.role === "CONSULTANT" &&
        userDetails.consultantProfileId
      ) {
        router.replace(
          `/dashboard/consultant/${userDetails.consultantProfileId}/home`,
        );
      } else if (userDetails.consulteeProfileId) {
        router.replace(
          `/dashboard/consultee/${userDetails.consulteeProfileId}/home`,
        );
      } else {
        router.replace("/dashboard");
      }
    }
  }, [
    userDetails,
    hasStaffAccess,
    isLoadingUser,
    isSessionLoading,
    userId,
    router,
  ]);

  // Auth check first
  if (!session?.user?.id && !isSessionLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">
          Authentication required. Redirecting...
        </p>
      </div>
    );
  }

  // ACCESS DENIED CHECK - BEFORE skeleton to avoid showing skeleton for unauthorized users
  if (userDetails && !hasStaffAccess) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="text-center p-8 bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-zinc-200 dark:border-zinc-800">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 dark:bg-amber-900/20 flex items-center justify-center">
            <Shield className="w-8 h-8 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            Access Denied
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400 mb-4">
            You don&apos;t have permission to access the Staff Portal.
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            Redirecting to your dashboard...
          </p>
        </div>
      </div>
    );
  }

  // Show loading state only if we don't have userDetails yet (still determining access)
  if ((isSessionLoading || isLoadingUser) && !userDetails) {
    return (
      <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
        {/* Sidebar skeleton */}
        <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <Skeleton className="h-8 w-32 mb-6" />
          <div className="space-y-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        </aside>
        {/* Main content skeleton */}
        <main className="flex-1 p-6">
          <Skeleton className="h-8 w-64 mb-4" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </main>
      </div>
    );
  }

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
        {/* Sidebar */}
        <aside
          className={cn(
            "flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 transition-all duration-300",
            collapsed ? "w-16" : "w-64",
          )}
        >
          {/* Header with User Profile */}
          <div className="border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center justify-between h-16 px-4">
              {!collapsed && (
                <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  Staff Portal
                </h1>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setCollapsed(!collapsed)}
                className="h-8 w-8"
              >
                {collapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronLeft className="h-4 w-4" />
                )}
              </Button>
            </div>

            {/* User Profile */}
            <div className={cn("px-4 pb-4", collapsed && "px-2")}>
              <div
                className={cn(
                  "flex items-center gap-3",
                  collapsed && "justify-center",
                )}
              >
                <Avatar className="h-10 w-10 flex-shrink-0">
                  <AvatarImage
                    src={session?.user?.image || ""}
                    alt={session?.user?.name || ""}
                  />
                  <AvatarFallback className="bg-blue-600 text-white font-semibold">
                    {session?.user?.name?.charAt(0)?.toUpperCase() || "S"}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {session?.user?.name || "Staff Member"}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {session?.user?.email}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto py-4">
            <TooltipProvider delayDuration={0}>
              <ul className="space-y-1 px-2">
                {sidebarItems.map((item) => (
                  <li key={item.path}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link
                          href={`/dashboard/staff/${staffId}/${item.path}`}
                          className={cn(
                            "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                            isActive(item.path)
                              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                              : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
                          )}
                        >
                          <item.icon className="h-5 w-5 flex-shrink-0" />
                          {!collapsed && <span>{item.name}</span>}
                        </Link>
                      </TooltipTrigger>
                      {collapsed && (
                        <TooltipContent side="right">
                          {item.name}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </TooltipProvider>
          </nav>

          {/* Footer */}
          <div className="border-t border-zinc-200 dark:border-zinc-800 p-2">
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleSignOut}
                    className={cn(
                      "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950",
                      collapsed && "justify-center",
                    )}
                  >
                    <LogOut className="h-5 w-5 flex-shrink-0" />
                    {!collapsed && <span>Sign Out</span>}
                  </button>
                </TooltipTrigger>
                {collapsed && (
                  <TooltipContent side="right">Sign Out</TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            {!collapsed && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3 px-3">
                Familiarise Staff v1.0
              </p>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="sticky top-0 z-30 flex items-center justify-end gap-2 px-6 py-2 border-b border-zinc-200/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl">
            <NotificationInbox />
          </div>
          <div className="p-6">{children}</div>
        </main>
      </div>
    </NovuProvider>
  );
}
