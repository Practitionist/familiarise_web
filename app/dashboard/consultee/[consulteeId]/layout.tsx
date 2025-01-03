"use client";

import { ConsulteeProfile, User } from "@prisma/client";
import { Button } from "components/ui/button";
import { fetchConsulteeDetails, fetchUserDetails } from "hooks/useUserData";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useEffect, useState } from "react";
import { UserProvider } from "./UserContext";

// Navigation configuration
const NAV_ITEMS = [
  { name: "Home", path: "home" },
  { name: "Appointments", path: "appointments" },
  { name: "Booking History", path: "history" },
  { name: "Messages", path: "messages" },
  { name: "Feedback & Support", path: "feedback" },
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
}: Readonly<ConsulteeNavProps>) {
  return (
    <nav className="p-4 sm:p-8 pt-32 md:pt-36 bg-white shadow-sm">
      <div className="flex flex-col sm:flex-row justify-start items-start gap-4">
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 w-full">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.name}
              href={`/dashboard/consultee/${consulteeId}/${item.path}`}
            >
              <Button
                className={`${
                  currentPath === item.path
                    ? "bg-[#f87171] text-white"
                    : "text-gray-500 hover:bg-gray-200"
                } rounded-md px-4 py-2 transition-colors whitespace-nowrap`}
                variant={currentPath === item.path ? "default" : "ghost"}
              >
                {item.name}
              </Button>
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}

// Custom hook for data fetching
function useConsulteeData(consulteeId: string) {
  const { data: session } = useSession();
  const [state, setState] = useState({
    userDetails: null as User | null,
    profileDetails: null as ConsulteeProfile | null,
    error: null as string | null,
    isLoading: true,
  });

  useEffect(() => {
    async function fetchData() {
      try {
        setState((prev) => ({ ...prev, isLoading: true, error: null }));

        const userId =
          process.env.NODE_ENV === "test" ||
          process.env.NODE_ENV === "development"
            ? process.env.NEXT_PUBLIC_TEST_USERID
            : session?.user?.id;

        if (!userId) {
          throw new Error("User not authenticated");
        }

        const [userData, consulteeData] = await Promise.all([
          fetchUserDetails(userId),
          fetchConsulteeDetails(consulteeId),
        ]);

        setState({
          userDetails: userData,
          profileDetails: consulteeData,
          error: null,
          isLoading: false,
        });
      } catch (err) {
        console.error("Error fetching data:", err);
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : "An error occurred",
          isLoading: false,
        }));
      }
    }

    fetchData();
  }, [session, consulteeId]);

  return state;
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

  const { userDetails, profileDetails, error, isLoading } =
    useConsulteeData(consulteeId);

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
    return <MessageContainer title="Error" message={error} />;
  }

  // Loading state
  if (isLoading || !userDetails || !profileDetails) {
    return (
      <MessageContainer
        title="Loading..."
        message="Please wait while we fetch your data."
        titleColor="text-gray-900"
      />
    );
  }

  // Main layout
  return (
    <UserProvider userDetails={userDetails}>
      <div className="bg-gray-100 min-h-screen flex flex-col">
        <ConsulteeNav consulteeId={consulteeId} currentPath={currentPath} />
        <main className="flex-grow overflow-y-auto p-8">{children}</main>
      </div>
    </UserProvider>
  );
}
