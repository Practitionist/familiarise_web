"use client";

import { BellIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchConsulteeDetails, fetchUserDetails } from "@/hooks/useUserData";
import { ConsulteeProfile, User } from "@prisma/client";
import { useSession } from "next-auth/react";
import { use, useEffect, useState } from "react";
import AppointmentsTab from "./tabs/AppointmentsTab";
import BookingHistoryTab from "./tabs/BookingHistoryTab";
import FeedbackSupportTab from "./tabs/FeedbackSupportTab";
import HomeTab from "./tabs/HomeTab";
import MessagesTab from "./tabs/MessagesTab";
import PolicyTab from "./tabs/PolicyTab";

const tabs = [
  "Home",
  "Appointments",
  "Booking History",
  "Messages",
  "Feedback & Support",
  "Policy",
];

type Params = Promise<{ consulteeId: string }>;
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function ConsulteeDashboard(
  props: Readonly<{
    params: Params;
    searchParams: SearchParams;
  }>,
) {
  const resolvedParams = use(props.params);
  const consulteeId = resolvedParams.consulteeId;

  const [activeTab, setActiveTab] = useState("Home");
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

        if (!session?.user?.id) {
          throw new Error("User not authenticated");
        }

        const [userData, consulteeData] = await Promise.all([
          fetchUserDetails(session.user.id),
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

  if (!session?.user?.id) {
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
    <div className="bg-gray-100 min-h-screen flex flex-col">
      <div className="p-8 pt-32 bg-white shadow-sm">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center space-x-4 overflow-x-auto">
            {tabs.map((tab) => (
              <Button
                key={tab}
                className={`${
                  activeTab === tab
                    ? "bg-[#f87171] text-white"
                    : "text-gray-500 hover:bg-gray-200"
                } rounded-md px-4 py-2 transition-colors whitespace-nowrap`}
                variant={activeTab === tab ? "default" : "ghost"}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </Button>
            ))}
          </div>
          <div className="flex items-center space-x-4">
            <Input
              placeholder="Search here..."
              className="rounded-md px-4 py-2 border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#f87171] focus:border-transparent"
            />
            <BellIcon className="h-6 w-6 text-gray-500 hover:text-gray-700 cursor-pointer" />
          </div>
        </div>
      </div>
      <div className="flex-grow overflow-y-auto p-8">
        {activeTab === "Home" && (
          <HomeTab userDetails={userDetails} consulteeId={consulteeId} />
        )}
        {activeTab === "Appointments" && (
          <AppointmentsTab consulteeId={consulteeId} />
        )}
        {activeTab === "Booking History" && (
          <BookingHistoryTab consulteeId={consulteeId} />
        )}
        {activeTab === "Messages" && <MessagesTab />}
        {activeTab === "Feedback & Support" && <FeedbackSupportTab />}
        {activeTab === "Policy" && <PolicyTab />}
      </div>
    </div>
  );
}
