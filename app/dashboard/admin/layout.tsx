"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { UserRole } from "@prisma/client";

// Navigation configuration for admin
const NAV_ITEMS = [
  { name: "Overview", path: "home", icon: "📊" },
  { name: "Payments", path: "payments", icon: "💳" },
  { name: "Refunds", path: "refunds", icon: "↩️" },
  { name: "Disputes", path: "disputes", icon: "⚠️" },
  { name: "Analytics", path: "analytics", icon: "📈" },
  { name: "Users", path: "users", icon: "👥" },
] as const;

interface PageProps {
  children: React.ReactNode;
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

// Fetch admin user data
async function fetchAdminData(userId: string) {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch admin data");
  }
  const result = await response.json();
  return result.data; // API returns { data: user }
}

// Main layout component
export default function AdminLayout({ children }: Readonly<PageProps>) {
  const pathname = usePathname();
  const currentPath = pathname.split("/").pop();
  const { data: session } = useSession();
  const router = useRouter();

  // Fetch user data
  const userId = session?.user?.id;

  const {
    data: userData,
    error,
    isLoading,
  } = useQuery({
    queryKey: [`admin-${userId}`, userId],
    queryFn: () => fetchAdminData(userId as string),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  // Authentication check
  if (!session?.user?.id) {
    return (
      <MessageContainer
        title="Authentication Required"
        message="Please sign in to access the admin dashboard."
      />
    );
  }

  // Role check - only ADMIN can access
  if (userData && userData.role !== UserRole.ADMIN) {
    return (
      <MessageContainer
        title="Access Denied"
        message="You do not have permission to access the admin dashboard."
      />
    );
  }

  // Lightweight hover prefetching
  const handleNavHover = (path: string) => {
    router.prefetch(`/dashboard/admin/${path}`);
  };

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
                  src={userData?.image || "/placeholder.svg"}
                  alt={userData?.name || ""}
                />
                <AvatarFallback>
                  {userData?.name?.charAt(0) || "A"}
                </AvatarFallback>
              </Avatar>
              <div>
                <h2 className="font-semibold">{userData?.name}</h2>
                <p className="text-sm text-gray-500">ADMIN</p>
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
                  href={`/dashboard/admin/${item.path}`}
                  className={`flex items-center space-x-2 p-2 rounded-md transition-colors ${
                    currentPath === item.path
                      ? "bg-blue-50 text-blue-600"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                  prefetch={true}
                  onMouseEnter={() => handleNavHover(item.path)}
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
            href="/dashboard/admin/settings"
            className={`flex items-center space-x-2 p-4 transition-colors ${
              currentPath === "settings"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-600 hover:bg-gray-100"
            }`}
            prefetch={true}
            onMouseEnter={() => router.prefetch("/dashboard/admin/settings")}
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
          <div className="flex items-center justify-center h-full">
            <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
              <h2 className="text-xl sm:text-2xl font-bold text-red-600 mb-4">
                Error
              </h2>
              <p className="text-gray-700">
                {error instanceof Error
                  ? error.message
                  : "An unknown error occurred"}
              </p>
            </div>
          </div>
        ) : (
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        )}
      </main>
    </div>
  );
}
