"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useUserData } from "@/hooks/useUserData";
import { useToast } from "@/components/ui/use-toast";

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const { toast } = useToast();

  const userId = session?.user?.id;
  const {
    userDetails,
    isLoading: isUserDataLoading,
    error,
  } = useUserData(userId || "");

  // Handle progress animation
  useEffect(() => {
    let progressInterval: ReturnType<typeof setInterval>;

    if (isLoading || isUserDataLoading) {
      // Start from current progress or 0
      let currentProgress = progress;

      progressInterval = setInterval(() => {
        // Increment progress but slow down as it gets higher
        const increment = Math.max(1, (100 - currentProgress) / 20);
        currentProgress = Math.min(90, currentProgress + increment);
        setProgress(currentProgress);
      }, 100);
    } else {
      // When loading is complete, quickly fill to 100%
      setProgress(100);
    }

    return () => {
      if (progressInterval) clearInterval(progressInterval);
    };
  }, [isLoading, isUserDataLoading]);

  useEffect(() => {
    if (status === "authenticated" && !isUserDataLoading) {
      if (error) {
        toast({
          title: "Error loading user data",
          description: error.message || "Please try refreshing the page.",
          variant: "destructive",
        });
        setIsLoading(false);
        return;
      }

      if (userDetails) {
        // Simulating a 3-5 second loading time
        const timer = setTimeout(() => {
          setIsLoading(false);

          // Redirect based on user role and profile ID
          switch (userDetails.role) {
            case "CONSULTANT":
              router.push(
                userDetails.consultantProfileId
                  ? `/dashboard/consultant/${userDetails.consultantProfileId}`
                  : "/",
              );
              break;
            case "CONSULTEE":
              router.push(
                userDetails.consulteeProfileId
                  ? `/dashboard/consultee/${userDetails.consulteeProfileId}`
                  : "/",
              );
              break;
            case "ADMIN":
              router.push("/dashboard/admin");
              break;
            case "STAFF":
              router.push(
                userDetails.staffProfileId
                  ? `/dashboard/staff/${userDetails.staffProfileId}`
                  : "/",
              );
              break;
            default:
              router.push("/dashboard/error");
          }
        }, 1000); // 1 second delay

        return () => clearTimeout(timer);
      }
    }
  }, [status, isUserDataLoading, userDetails, router, error, toast]);

  if (status === "loading" || isLoading || isUserDataLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Card className="w-[300px]">
          <CardHeader>
            <CardDescription>Loading your dashboard...</CardDescription>
          </CardHeader>
          <CardContent>
            <progress
              className="w-full h-2.5 rounded-full"
              value={progress}
              max={100}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !userDetails) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Card className="w-[300px]">
          <CardHeader>
            <CardTitle>Error loading dashboard</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              There was an error loading your dashboard:{" "}
              {error ? error.message : "Unknown error"}
            </p>
            <p>
              Please try refreshing the page or contact support if the problem
              persists.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // This return statement will only be shown briefly before redirection
  return null;
}
