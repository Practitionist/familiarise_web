"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

export const InitializeChannelsButton = () => {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleInitializeChannels = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/stream/initialize-channels", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Channels initialized successfully",
          description: `Created channels for ${data.result.counts.webinars} webinars, ${data.result.counts.classes} classes, ${data.result.counts.consultations} consultations, and ${data.result.counts.subscriptions} subscriptions.`,
        });
      } else {
        toast({
          title: "Error initializing channels",
          description: data.error || "An error occurred",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error initializing channels:", error);
      toast({
        title: "Error initializing channels",
        description: (error as Error).message || "An error occurred",
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
