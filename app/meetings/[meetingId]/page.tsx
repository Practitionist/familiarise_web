"use client";

import { useToast } from "@/components/ui/use-toast";
import MeetingUI from "../components/meeting-ui";
import {
  StreamCall,
  StreamVideo,
  StreamVideoClient,
} from "@stream-io/video-react-sdk";
import { Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { use, useEffect, useRef, useState } from "react";

interface MeetingPageProps {
  params: Promise<{
    meetingId: string;
  }>;
}

export default function MeetingPage({ params }: Readonly<MeetingPageProps>) {
  const { meetingId } = use(params);
  const { data: session } = useSession();
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<any>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!session?.user?.id) return;

    let mounted = true;

    const initClient = async () => {
      try {
        // Get token from our API
        const response = await fetch("/api/meetings/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: session.user.id }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to get token: ${error}`);
        }
        if (!mounted) return;

        const { token } = await response.json();
        if (!token) {
          throw new Error("No token received from server");
        }

        const user = {
          id: session.user.id,
          name: session.user.name ?? session.user.id,
          type: "authenticated" as const,
        };

        // Initialize Stream client
        const streamClient = new StreamVideoClient(
          process.env.NEXT_PUBLIC_STREAM_API_KEY!,
          {
            logLevel: "info",
          },
        );

        // Connect user
        await streamClient.connectUser(user, token);
        if (!mounted) {
          streamClient.disconnectUser();
          return;
        }

        // Store cleanup function
        cleanupRef.current = () => {
          streamClient.disconnectUser();
        };

        setClient(streamClient);

        // Create and join call
        const newCall = streamClient.call("default", meetingId);
        await newCall.join({ create: true });
        if (!mounted) {
          newCall.leave();
          return;
        }
        setCall(newCall);
      } catch (error) {
        console.error("Error initializing meeting:", error);
        // Show error to user
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        toast({
          title: "Error",
          description: `Failed to initialize meeting: ${errorMessage}`,
          variant: "destructive",
        });
      }
    };

    initClient();

    return () => {
      mounted = false;
      const cleanup = async () => {
        try {
          if (call) {
            // Ensure camera and mic are disabled before leaving
            const promises = [];
            const cameraManager = call.camera;
            const microphoneManager = call.microphone;

            if (cameraManager?.enabled) {
              promises.push(cameraManager.disable());
            }
            if (microphoneManager?.enabled) {
              promises.push(microphoneManager.disable());
            }

            // Wait for all devices to be disabled
            await Promise.all(promises);
            await call.leave();
          }

          // Run stored cleanup function
          if (cleanupRef.current) {
            cleanupRef.current();
          }
        } catch (error) {
          console.error("Error during cleanup:", error);
          toast({
            title: "Error",
            description: "Failed to clean up meeting",
            variant: "destructive",
          });
        }
      };
      // Execute cleanup immediately
      cleanup().catch(console.error);
    };
  }, [session?.user, meetingId]);

  if (!session?.user || !client || !call) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <MeetingUI />
      </StreamCall>
    </StreamVideo>
  );
}
