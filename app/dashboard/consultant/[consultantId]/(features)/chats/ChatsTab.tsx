"use client";

import { initializeAllChannels } from "@/actions/channel.action";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { DebugButton } from "@/components/chat/DebugButton";
import { InitializeChannelsButton } from "@/components/chat/InitializeChannelsButton";
import { useToast } from "@/components/ui/use-toast";
import { fetchConsultantDetails } from "@/lib/user";
import StreamChatProvider from "@/providers/StreamChatProvider";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export function ChatsTab() {
  const { consultantId } = useParams();
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchUserId = async () => {
      try {
        const consultantDetails = await fetchConsultantDetails(consultantId as string);
        
        // Check if user property exists before accessing its properties
        if (consultantDetails && consultantDetails.user) {
          setUserId(consultantDetails.user.id);
          setUserRole(consultantDetails.user.role);
        } else {
          console.error("User property missing in consultant details");
          toast({
            title: "Error",
            description: "Failed to get user information. Please try again later.",
            variant: "destructive",
          });
        }
      } catch (error) {
        console.error("Error fetching consultant details:", error);
        toast({
          title: "Error",
          description: "Failed to load user data. Please try again later.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    if (consultantId) {
      fetchUserId();
    }
  }, [consultantId]);

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
          description: "Channels have been created for all webinars, classes, consultations, and subscriptions.",
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
      <div className="flex h-full w-full items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* Admin tools - only visible to admins */}
      {userRole === "ADMIN" && (
        <div className="mb-4 p-4 bg-gray-100 rounded-lg">
          <h3 className="text-lg font-medium mb-2">Admin Tools</h3>
          <p className="text-sm text-gray-600 mb-2">
            Use these tools to debug and initialize Stream Chat channels.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-sm font-medium mb-1">Initialize Channels</h4>
              <p className="text-xs text-gray-600 mb-2">
                Create channels for all webinars, classes, consultations, and subscriptions.
              </p>
              <InitializeChannelsButton />
              {initializing && (
                <p className="text-xs text-blue-600 mt-2">
                  Initializing channels... This may take a moment.
                </p>
              )}
            </div>
            <div>
              <h4 className="text-sm font-medium mb-1">Debug Stream Chat</h4>
              <p className="text-xs text-gray-600 mb-2">
                View debug information about channels, consultations, subscriptions, webinars, and classes.
              </p>
              <DebugButton userId={userId} />
            </div>
          </div>
        </div>
      )}
      
      <div className="flex-1 bg-white rounded-lg shadow-lg overflow-hidden">
        <StreamChatProvider userId={userId}>
          <ChatLayout />
        </StreamChatProvider>
      </div>
    </div>
  );
}
