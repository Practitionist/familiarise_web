"use client";

import { ConsulteeProfile, User } from "@prisma/client";
import { Button } from "components/ui/button";
import { fetchConsulteeDetails, fetchUserDetails } from "hooks/useUserData";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useEffect, useState } from "react";
import { UserProvider } from "./UserContext";

const navItems = [
  { name: "Home", path: "home" },
  { name: "Appointments", path: "appointments" },
  { name: "Booking History", path: "history" },
  { name: "Messages", path: "messages" },
  { name: "Feedback & Support", path: "feedback" },
  { name: "Policy", path: "policy" },
];

type PageProps = {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
};

export default function ConsulteeLayout({
  children,
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;

  const pathname = usePathname();
  const currentPath = pathname.split("/").pop();

  const { data: session } = useSession();
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [profileDetails, setProfileDetails] = useState<ConsulteeProfile | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        if (!process.env.NEXT_PUBLIC_TEST_USERID && !session?.user?.id) {
          throw new Error("User not authenticated");
        }

        const [userData, consulteeData] = await Promise.all([
          fetchUserDetails(
            process.env.NEXT_PUBLIC_TEST_USERID ?? session?.user?.id ?? "",
          ),
          fetchConsulteeDetails(consulteeId),
        ]);

        setUserDetails(userData);
        setProfileDetails(consulteeData);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, [session, consulteeId]);

  if (!process.env.NEXT_PUBLIC_TEST_USERID && !session?.user?.id) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
          <h2 className="text-xl sm:text-2xl font-bold text-red-600 mb-4">
            Authentication Required
          </h2>
          <p className="text-gray-700">
            Please sign in to access your dashboard.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
          <h2 className="text-xl sm:text-2xl font-bold text-red-600 mb-4">
            Error
          </h2>
          <p className="text-gray-700">{error}</p>
        </div>
      </div>
    );
  }

  if (isLoading || !userDetails || !profileDetails) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
          <h2 className="text-xl sm:text-2xl font-bold mb-4">Loading...</h2>
          <p className="text-gray-700">Please wait while we fetch your data.</p>
        </div>
      </div>
    );
  }

  return (
    <UserProvider userDetails={userDetails}>
      <div className="bg-gray-100 min-h-screen flex flex-col">
        <div className="p-4 sm:p-8 pt-32 md:pt-36 bg-white shadow-sm">
          <div className="flex flex-col sm:flex-row justify-start items-start gap-4">
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 w-full">
              {navItems.map((item) => (
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
        </div>
        <div className="flex-grow overflow-y-auto p-8">{children}</div>
      </div>
    </UserProvider>
  );
}
