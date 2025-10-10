"use client";

import { initializeAllChannels } from "@/actions/stream/chat/channel.action";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { useToast } from "@/components/ui/use-toast";
import StreamChatProvider from "@/providers/StreamChatProvider";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConsulteeQueries } from "@/hooks/useConsulteePrefetchDashboard";

export default function MessagesTab() {
  const { consulteeId } = useParams();
  const [initializing, setInitializing] = useState(false);
  const { toast } = useToast();

  // Use the centralized query configuration
  const profileQuery = createConsulteeQueries(consulteeId as string).profile;
  const {
    data: consulteeDetails,
    isLoading: loading,
    error,
  } = useQuery(profileQuery);

  const userId = consulteeDetails?.user?.id || null;
  const userRole = consulteeDetails?.user?.role || null;

  // Handle errors
  useEffect(() => {
    if (error) {
      console.error("Error fetching consultee details:", error);
      toast({
        title: "Error",
        description: "Failed to load user data. Please try again later.",
        variant: "destructive",
      });
    }
  }, [error, toast]);

  // Auto-initialize channels when the component loads
  useEffect(() => {
    const autoInitializeChannels = async () => {
      if (!userId) return;

      try {
        setInitializing(true);
        console.log("Auto-initializing channels...");

        const result = await initializeAllChannels();

        console.log("Channels initialized:", result);

        toast({
          title: "Channels initialized",
          description:
            "Channels have been created for all webinars, classes, consultations, and subscriptions.",
        });
      } catch (error) {
        console.error("Error initializing channels:", error);

        toast({
          title: "Error initializing channels",
          description: (error as Error).message || "An error occurred",
          variant: "destructive",
        });
      } finally {
        setInitializing(false);
      }
    };

    if (userRole === "ADMIN") {
      autoInitializeChannels();
    }
  }, [userId, userRole, toast]);

  if (loading || !userId) {
    return (
      <div className="min-h-[calc(100vh-200px)]">
        <div className="h-[calc(100vh-220px)] w-full flex items-center justify-center">
          <div className="text-center space-y-4">
            <div className="relative inline-flex">
              <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-200 border-t-blue-600"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-8 w-8 rounded-full bg-blue-100"></div>
              </div>
            </div>
            <div className="text-gray-700 text-base font-medium">
              Loading messages...
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-200px)] flex flex-col w-full">
      {initializing && (
        <div className="mb-6 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border-l-4 border-blue-500 rounded-xl shadow-sm">
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-200 border-t-blue-600"></div>
            <p className="text-sm text-blue-700 font-medium">
              Initializing channels... This may take a moment.
            </p>
          </div>
        </div>
      )}
      <div className="h-[calc(100vh-220px)] w-full bg-white rounded-2xl shadow-xl border-2 border-gray-100 overflow-hidden flex-grow">
        <StreamChatProvider userId={userId}>
          <ChatLayout />
        </StreamChatProvider>
      </div>
    </div>
  );
}
