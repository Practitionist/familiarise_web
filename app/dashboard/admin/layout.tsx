"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import {
  DashboardSidebar,
  type NavSection,
} from "@/components/dashboard/DashboardSidebar";
import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { schedulePrefetch } from "@/lib/dashboard-queries";
import { useEffect } from "react";

// Navigation configuration for admin with sections
const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [{ name: "Overview", path: "home" }],
  },
  {
    title: null,
    items: [{ name: "Announcements", path: "announcements" }],
  },
  {
    title: "Support",
    items: [
      { name: "Support Tickets", path: "tickets" },
      { name: "User Feedback", path: "feedback" },
    ],
  },
  {
    title: "Payments",
    items: [
      { name: "All Payments", path: "payments" },
      { name: "Approval Payments", path: "approval-payments" },
      { name: "Subscriptions", path: "subscriptions" },
      { name: "Refunds", path: "refunds" },
      { name: "Disputes", path: "disputes" },
    ],
  },
  {
    title: "Payouts",
    items: [
      { name: "Pending Approval", path: "payouts/pending" },
      { name: "Processing", path: "payouts/processing" },
      { name: "Completed", path: "payouts/completed" },
      { name: "Consultant Earnings", path: "payouts/earnings" },
    ],
  },
  {
    title: null,
    items: [
      { name: "Invoices", path: "invoices" },
      { name: "Analytics", path: "analytics" },
      { name: "Users", path: "users" },
    ],
  },
  {
    title: null,
    items: [{ name: "Waitlists", path: "waitlists" }],
  },
  {
    title: "System",
    items: [{ name: "System Jobs", path: "system-jobs" }],
  },
];

const BOTTOM_NAV_ITEMS = [{ name: "Settings", path: "settings" }];

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
        <a
          href="/"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Go Home
        </a>
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
  const { data: session } = useSession();
  const router = useRouter();

  const userId = session?.user?.id;

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

  // Prefetch common routes
  useEffect(() => {
    if (!userId) return;

    schedulePrefetch(() => {
      router.prefetch("/dashboard/admin/home");
      router.prefetch("/dashboard/admin/payments");
    }, 3000);
  }, [userId, router]);

  // Auth check
  if (!session?.user?.id) {
    return (
      <AccessDenied
        title="Authentication Required"
        message="Please sign in to access the admin dashboard."
      />
    );
  }

  // Initial loading
  if (isLoading && !userData) {
    return <DashboardSkeleton />;
  }

  // Note: Role-based access control is handled by middleware
  // This layout trusts that middleware has already validated the user's role

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

  // Build sidebar
  const sidebar = (
    <DashboardSidebar
      userImage={userData?.image}
      userName={userData?.name}
      userRole="ADMIN"
      basePath="/dashboard/admin"
      navSections={NAV_SECTIONS}
      bottomNavItems={BOTTOM_NAV_ITEMS}
      isLoading={isLoading}
    />
  );

  return (
    <DashboardShell sidebar={sidebar}>
      <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
    </DashboardShell>
  );
}
