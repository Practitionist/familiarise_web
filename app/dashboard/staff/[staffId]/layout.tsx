"use client";

import {
  CreditCard,
  Home,
  Settings,
  Shield,
  Ticket,
  Users,
  Calendar,
  Wallet,
  Receipt,
  Star,
  Play,
  RotateCcw,
  AlertTriangle,
  RefreshCw,
  BarChart3,
  Clock,
  Megaphone,
  Wrench,
} from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";
import NovuProvider from "@/providers/NovuProvider";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { useQuery } from "@tanstack/react-query";
import { fetchUserDetails } from "@/lib/user";
import { getEffectiveUserId } from "@/utils/auth";
import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";

const sidebarItems: CollapsibleSidebarItem[] = [
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

  const userId = getEffectiveUserId(session);

  // Fetch user details to check staff access
  const {
    data: userDetails,
    isLoading: isLoadingUser,
    error: _userError,
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
    return <CollapsibleSidebarSkeleton />;
  }

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
        <CollapsibleSidebar
          items={sidebarItems}
          basePath={`/dashboard/staff/${staffId}`}
          title="Staff Portal"
          footerLabel="Familiarise Staff v1.0"
          avatarFallback="S"
          userName={session?.user?.name || "Staff Member"}
          userEmail={session?.user?.email}
          userImage={session?.user?.image}
          pathname={pathname}
          onSignOut={handleSignOut}
        />

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
