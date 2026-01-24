"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Clock, Loader2, Bell } from "lucide-react";

interface JoinWaitlistButtonProps {
  eventType: "webinar" | "class";
  eventId: string;
  isOnWaitlist?: boolean;
  waitlistPosition?: number | null;
  onJoined?: (position: number) => void;
  className?: string;
}

export function JoinWaitlistButton({
  eventType,
  eventId,
  isOnWaitlist = false,
  waitlistPosition,
  onJoined,
  className,
}: JoinWaitlistButtonProps) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const [isJoining, setIsJoining] = useState(false);
  const [position, setPosition] = useState<number | null>(waitlistPosition ?? null);
  const [joined, setJoined] = useState(isOnWaitlist);

  // Sync state with props when they change
  useEffect(() => {
    setPosition(waitlistPosition ?? null);
    setJoined(isOnWaitlist);
  }, [waitlistPosition, isOnWaitlist]);

  const handleJoinWaitlist = async () => {
    if (!session?.user) {
      // Redirect to login with callback
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(window.location.href)}`;
      return;
    }

    setIsJoining(true);

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          [eventType === "webinar" ? "webinarId" : "classId"]: eventId,
        }),
      });

      const result = await response.json();

      if (result.success) {
        setJoined(true);
        setPosition(result.data.position);
        onJoined?.(result.data.position);
        toast({
          title: "Added to Waitlist",
          description: `You're #${result.data.position} in line. We'll notify you when a spot opens up!`,
          variant: "success",
        });
      } else {
        toast({
          title: "Could not join waitlist",
          description: result.error || "Something went wrong",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to join waitlist. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsJoining(false);
    }
  };

  if (joined) {
    return (
      <div className={className}>
        <Button
          disabled
          variant="outline"
          className="w-full border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-50"
        >
          <Bell className="h-4 w-4 mr-2" />
          On Waitlist
          {position && (
            <Badge
              variant="secondary"
              className="ml-2 bg-amber-200 text-amber-800 font-semibold"
            >
              #{position}
            </Badge>
          )}
        </Button>
        <p className="text-xs text-center text-amber-600 mt-2">
          We'll notify you when a spot opens up
        </p>
      </div>
    );
  }

  return (
    <Button
      onClick={handleJoinWaitlist}
      disabled={isJoining}
      className={`w-full bg-amber-500 hover:bg-amber-600 text-white ${className}`}
    >
      {isJoining ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Joining...
        </>
      ) : (
        <>
          <Clock className="h-4 w-4 mr-2" />
          Join Waitlist
        </>
      )}
    </Button>
  );
}

export default JoinWaitlistButton;
