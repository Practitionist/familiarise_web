"use client";

import { syncUserEventChannels } from "@/actions/stream/chat/event-channel.action";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

interface InitializeUserChannelsButtonProps {
  userId: string;
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  children?: React.ReactNode;
  onSuccess?: () => void;
}

export const InitializeUserChannelsButton = ({
  userId,
  variant = "default",
  size = "default",
  className = "",
  children,
  onSuccess,
}: InitializeUserChannelsButtonProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleInitializeChannels = async () => {
    if (!userId) {
      toast({
        title: "Error",
        description: "User ID is required",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);

    try {
      // console.log(`Initializing channels for user via action: ${userId}`);
      const result = await syncUserEventChannels(userId);

      toast({
        title: "Success",
        description: "Channels synchronized successfully",
      });

      // console.log("Channels synchronized result:", result);

      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error("Error initializing channels via action:", error);
      toast({
        title: "Error",
        description: `Failed to synchronize channels: ${(error as Error).message}`,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={handleInitializeChannels}
      disabled={isLoading}
    >
      {isLoading ? "Initializing..." : children || "Initialize My Channels"}
    </Button>
  );
};
