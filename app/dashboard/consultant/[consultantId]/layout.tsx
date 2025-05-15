"use client";

import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Skeleton } from "components/ui/skeleton";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useEffect, useState } from "react";
import { TConsultantProfile } from "types/consultant";
import { fetchConsultantData } from "./utils/fetchHelpers";
import { getEffectiveUserId } from "@/utils/auth";

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

// Custom hook for data fetching
function useConsultantData(consultantId: string) {
  const { data: session } = useSession();
  const [state, setState] = useState({
    consultantData: null as TConsultantProfile | null,
    error: null as string | null,
    isLoading: true,
  });

  useEffect(() => {
    async function fetchData() {
      try {
        setState((prev) => ({ ...prev, isLoading: true, error: null }));

        const userId = getEffectiveUserId(session);
        if (!userId) {
          throw new Error(
            "User not authenticated or user ID could not be determined.",
          );
        }

        const consultantData = await fetchConsultantData(consultantId);

        setState({
          consultantData,
          error: null,
          isLoading: false,
        });
      } catch (err) {
        console.error("Error fetching data:", err);
        let displayMessage = `An unexpected error occurred while attempting to load consultant (ID: ${consultantId}) information.`;

        if (err instanceof Error) {
          if (
            err.message ===
            "User not authenticated or user ID could not be determined."
          ) {
            // Specific error for initial user authentication failure
            displayMessage = err.message;
          } else {
            // Handle errors presumably from fetchConsultantData or subsequent operations
            const lowerCaseMessage = err.message.toLowerCase();
            if (lowerCaseMessage.includes("not found")) {
              displayMessage = `The consultant profile (ID: ${consultantId}) could not be found, or you may not have permission to view it. Please verify the ID and your access rights.`;
            } else if (
              lowerCaseMessage.includes("unauthorized") ||
              lowerCaseMessage.includes("forbidden")
            ) {
              displayMessage = `You are not authorized to view the data for consultant (ID: ${consultantId}).`;
            } else if (
              lowerCaseMessage.startsWith("failed to fetch consultant data")
            ) {
              // If the error message from fetchConsultantData is already somewhat descriptive
              displayMessage = err.message;
            } else {
              // General fallback for other errors related to fetching this consultant's data
              displayMessage = `An error occurred while fetching data for consultant (ID: ${consultantId}): ${err.message}`;
            }
          }
        }
        // For non-Error objects, the initial displayMessage will be used.
        setState((prev) => ({
          ...prev,
          error: displayMessage,
          isLoading: false,
        }));
      }
    }

    fetchData();
  }, [consultantId, session?.user?.id]);

  return state;
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

  const { consultantData, error, isLoading } = useConsultantData(consultantId);

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

  // Main layout
  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r relative min-h-screen flex flex-col">
        {/* Profile Section */}
        <div className="p-4 border-b">
          {isLoading || !consultantData ? (
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
                {error ?? "An unknown error occurred"}
              </p>
            </div>
          </div>
        ) : (
          // Render children when data is loaded and no error
          children
        )}
      </main>
    </div>
  );
}
