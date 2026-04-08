"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import NovuProvider from "@/providers/NovuProvider";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { signOut, useSession } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { schedulePrefetch } from "@/lib/dashboard-queries";
import { useEffect } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  CheckCircle2,
  Clock,
  CreditCard,
  Hourglass,
  Home,
  ListChecks,
  Megaphone,
  Play,
  Receipt,
  RefreshCw,
  RotateCcw,
  Star,
  Ticket,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";

// Navigation configuration for admin (flat list, mirrors staff sidebar layout)
const sidebarItems: CollapsibleSidebarItem[] = [
  { name: "Overview", icon: Home, path: "home" },
  { name: "Announcements", icon: Megaphone, path: "announcements" },
  { name: "Support Tickets", icon: Ticket, path: "tickets" },
  { name: "User Feedback", icon: Star, path: "feedback" },
  { name: "All Payments", icon: CreditCard, path: "payments" },
  { name: "Approval Payments", icon: BadgeCheck, path: "approval-payments" },
  { name: "Subscriptions", icon: RefreshCw, path: "subscriptions" },
  { name: "Refunds", icon: RotateCcw, path: "refunds" },
  { name: "Disputes", icon: AlertTriangle, path: "disputes" },
  { name: "Payouts: Pending", icon: Clock, path: "payouts/pending" },
  { name: "Payouts: Processing", icon: Hourglass, path: "payouts/processing" },
  { name: "Payouts: Completed", icon: CheckCircle2, path: "payouts/completed" },
  { name: "Consultant Earnings", icon: Wallet, path: "payouts/earnings" },
  { name: "Invoices", icon: Receipt, path: "invoices" },
  { name: "Analytics", icon: BarChart3, path: "analytics" },
  { name: "Users", icon: Users, path: "users" },
  { name: "Waitlists", icon: ListChecks, path: "waitlists" },
  { name: "System Jobs", icon: Play, path: "system-jobs" },
  { name: "Maintenance", icon: Wrench, path: "maintenance" },
];

interface PageProps {
  children: React.ReactNode;
}

// Fetch admin user data
async function fetchAdminData(userId: string) {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch admin data");
  }
  const result = await response.json();
  return result.data;
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

// Auth/Access denied display
function AccessDenied({ title, message }: { title: string; message: string }) {
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
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        <p className="text-zinc-600">{message}</p>
        <Link
          href="/"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Go Home
        </Link>
      </motion.div>
    </div>
  );
}

// Loading skeleton
function DashboardSkeleton() {
  return (
    <div className="flex min-h-screen bg-zinc-100">
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 bg-zinc-950 lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-zinc-800/50 px-6">
          <Skeleton className="h-9 w-9 rounded-lg bg-zinc-800" />
          <Skeleton className="h-5 w-24 bg-zinc-800" />
        </div>
        <div className="border-b border-zinc-800/50 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-full bg-zinc-800" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-28 bg-zinc-800" />
              <Skeleton className="h-3 w-20 bg-zinc-800" />
            </div>
          </div>
        </div>
        <div className="p-3 space-y-1">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg bg-zinc-800" />
          ))}
        </div>
      </aside>

      <main className="flex-1 lg:ml-64 p-8">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-8 w-48 bg-zinc-200" />
              <Skeleton className="h-4 w-64 bg-zinc-200" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-32 rounded-xl bg-white" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Skeleton className="h-96 rounded-xl bg-white" />
            <Skeleton className="h-96 rounded-xl bg-white" />
          </div>
        </div>
      </main>
    </div>
  );
}

// Main layout
export default function AdminLayout({ children }: Readonly<PageProps>) {
  const pathname = usePathname();
  const { data: session, isPending: isSessionLoading } = useSession();
  const router = useRouter();

  const userId = session?.user?.id;

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

  const {
    data: userData,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["admin-user", userId],
    queryFn: () => fetchAdminData(userId as string),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  // Check if user has admin access - must have role ADMIN
  const hasAdminAccess = userData?.role === "ADMIN";

  // Redirect unauthorized users to their appropriate dashboard
  useEffect(() => {
    if (isLoading || isSessionLoading || !userId) return;

    if (userData && !hasAdminAccess) {
      // User doesn't have admin access - redirect based on their role
      if (userData.role === "STAFF" && userData.staffProfileId) {
        router.replace(`/dashboard/staff/${userData.staffProfileId}/home`);
      } else if (
        userData.role === "CONSULTANT" &&
        userData.consultantProfileId
      ) {
        router.replace(
          `/dashboard/consultant/${userData.consultantProfileId}/home`,
        );
      } else if (userData.consulteeProfileId) {
        router.replace(
          `/dashboard/consultee/${userData.consulteeProfileId}/home`,
        );
      } else {
        router.replace("/dashboard");
      }
    }
  }, [userData, hasAdminAccess, isLoading, isSessionLoading, userId, router]);

  // Prefetch common routes
  useEffect(() => {
    if (!userId || !hasAdminAccess) return;

    schedulePrefetch(() => {
      router.prefetch("/dashboard/admin/home");
      router.prefetch("/dashboard/admin/payments");
    }, 3000);
  }, [userId, router, hasAdminAccess]);

  // Auth check
  if (!session?.user?.id && !isSessionLoading) {
    return (
      <AccessDenied
        title="Authentication Required"
        message="Please sign in to access the admin dashboard."
      />
    );
  }

  // ACCESS DENIED CHECK - BEFORE skeleton to avoid showing skeleton for unauthorized users
  if (userData && !hasAdminAccess) {
    return (
      <AccessDenied
        title="Access Denied"
        message="You don't have permission to access the Admin Dashboard. Redirecting to your dashboard..."
      />
    );
  }

  // Initial loading - only show if we don't have userData yet (still determining access)
  if ((isLoading || isSessionLoading) && !userData) {
    return <DashboardSkeleton />;
  }

  // Error state
  if (error) {
    return (
      <ErrorDisplay
        message={
          error instanceof Error ? error.message : "Failed to load dashboard"
        }
      />
    );
  }

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
        <CollapsibleSidebar
          items={sidebarItems}
          basePath="/dashboard/admin"
          title="Admin Portal"
          footerLabel="Familiarise Admin v1.0"
          avatarFallback="A"
          userName={userData?.name || "Admin"}
          userEmail={session?.user?.email}
          userImage={userData?.image}
          pathname={pathname}
          onSignOut={handleSignOut}
        />

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="sticky top-0 z-30 flex items-center justify-end gap-2 px-6 py-2 border-b border-zinc-200/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl">
            <NotificationInbox />
          </div>
          <div className="p-6">
            <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
          </div>
        </main>
      </div>
    </NovuProvider>
  );
}
