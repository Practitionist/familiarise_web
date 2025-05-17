"use client";

import { initializeAllChannels } from "@/actions/stream/chat/channel.action";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

export const InitializeChannelsButton = () => {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleInitializeChannels = async () => {
    setIsLoading(true);
    try {
      console.log("Initializing all channels via action...");
      const result = await initializeAllChannels();

      if (result.success) {
        toast({
          title: "Channels initialized successfully",
          description: `Created/checked channels for ${result.counts.webinars} webinars, ${result.counts.classes} classes, ${result.counts.consultations} consultations, and ${result.counts.subscriptions} subscriptions. Upserted ${result.counts.users} users.`,
        });
        console.log("Initialize all channels result:", result);
      } else {
        toast({
          title: "Error initializing channels",
          description: "An unexpected error occurred in the action.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error initializing channels via action:", error);
      toast({
        title: "Error initializing channels",
        description: (error as Error).message || "An unknown error occurred",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleInitializeChannels}
      disabled={isLoading}
      className="w-full"
    >
      {isLoading ? "Initializing..." : "Initialize All Channels"}
    </Button>
  );
};
