"use client";

import { initializeAllChannels } from "@/actions/stream/chat/channel.action";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { useToast } from "@/components/ui/use-toast";
import StreamChatProvider from "@/providers/StreamChatProvider";
import { useEffect, useState } from "react";

// Define props expected from the Server Component
interface ChatsTabProps {
  userId: string;
  userRole: string | null;
}

export function ChatsTab({ userId, userRole }: Readonly<ChatsTabProps>) {
  // consultantId might not be needed here anymore if initialization logic changes
  // const { consultantId } = useParams(); // Keep if still needed for other logic
  const [initializing, setInitializing] = useState(false);
  const { toast } = useToast();

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

  return (
    <div className="flex flex-col h-full w-full">
      {/* Admin tools - only visible to admins
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
      )} */}

      <div className="flex-1 bg-white rounded-lg shadow-lg overflow-hidden">
        <StreamChatProvider userId={userId}>
          <ChatLayout />
        </StreamChatProvider>
      </div>
    </div>
  );
}
