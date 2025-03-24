"use client";

import { initializeAllChannels } from "@/actions/channel.action";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { useToast } from "@/components/ui/use-toast";
import { fetchConsulteeDetails } from "@/lib/user";
import StreamChatProvider from "@/providers/StreamChatProvider";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function MessagesTab() {
  const { consulteeId } = useParams();
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchUserId = async () => {
      try {
        const consulteeDetails = await fetchConsulteeDetails(
          consulteeId as string,
        );

        // Check if user property exists before accessing its properties
        if (consulteeDetails?.user) {
          setUserId(consulteeDetails.user.id);
          setUserRole(consulteeDetails.user.role);
        } else {
          console.error("User property missing in consultee details");
          toast({
            title: "Error",
            description:
              "Failed to get user information. Please try again later.",
            variant: "destructive",
          });
        }
      } catch (error) {
        console.error("Error fetching consultee details:", error);
        toast({
          title: "Error",
          description: "Failed to load user data. Please try again later.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    if (consulteeId) {
      fetchUserId();
    }
  }, [consulteeId]);

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
        <h2 className="text-3xl font-bold mb-6">Messages</h2>
        <div className="h-[calc(100vh-280px)] w-full flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-200px)] flex flex-col w-full">
      {/* <h2 className="text-3xl font-bold mb-6">Messages</h2> */}
      {initializing && (
        <div className="mb-4 p-4 bg-blue-50 rounded-lg w-full">
          <p className="text-sm text-blue-600">
            Initializing channels... This may take a moment.
          </p>
        </div>
      )}
      <div className="h-[calc(100vh-220px)] w-full bg-white rounded-lg shadow-lg overflow-hidden flex-grow">
        <StreamChatProvider userId={userId}>
          <ChatLayout />
        </StreamChatProvider>
      </div>
    </div>
  );
}
