"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

interface InitializeUserChannelsButtonProps {
  userId: string;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
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
      const response = await fetch("/api/stream/initialize-user-channels", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        throw new Error(`Failed to initialize channels: ${await response.text()}`);
      }

      const data = await response.json();

      toast({
        title: "Success",
        description: "Channels initialized successfully",
      });

      console.log("Channels initialized:", data);
      
      // Call the onSuccess callback if provided
      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error("Error initializing channels:", error);
      toast({
        title: "Error",
        description: `Failed to initialize channels: ${(error as Error).message}`,
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
