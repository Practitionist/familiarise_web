"use client";

import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useUserData } from "@/hooks/useUserData";
import { useToast } from "@/components/ui/use-toast";

export default function Dashboard() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const { toast } = useToast();

  const userId = session?.user?.id;

  const {
    userDetails,
    isLoading: isUserDataLoading,
    error,
  } = useUserData(userId ?? "");

  // Defensive auth check: redirect if session is missing after loading
  useEffect(() => {
    if (!isPending && !session?.user?.id) {
      router.push("/auth/signin");
    }
  }, [isPending, session, router]);

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
    if (!!session && !isUserDataLoading) {
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
                  ? `/dashboard/consultant/${userDetails.consultantProfileId}/home`
                  : "/",
              );
              break;
            case "CONSULTEE":
              router.push(
                userDetails.consulteeProfileId
                  ? `/dashboard/consultee/${userDetails.consulteeProfileId}/home`
                  : "/",
              );
              break;
            case "ADMIN":
              router.push("/dashboard/admin/home");
              break;
            case "STAFF":
              router.push(
                userDetails.staffProfileId
                  ? `/dashboard/staff/${userDetails.staffProfileId}/home`
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
  }, [session, isUserDataLoading, userDetails, router, error, toast]);

  if (isPending || isLoading || isUserDataLoading) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-8">
          {/* Spinner */}
          <svg
            className="h-10 w-10 animate-spin"
            style={{ animationDuration: "0.8s" }}
            viewBox="0 0 40 40"
            fill="none"
          >
            <circle
              cx="20"
              cy="20"
              r="16"
              stroke="#e5e5e5"
              strokeWidth="3"
            />
            <circle
              cx="20"
              cy="20"
              r="16"
              stroke="#171717"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="75 25"
            />
          </svg>

          <div className="flex flex-col items-center gap-4">
            <p className="text-sm font-medium tracking-wide text-neutral-900">
              Loading your dashboard
            </p>

            {/* Progress bar */}
            <div className="h-[3px] w-48 overflow-hidden rounded-full bg-neutral-100">
              <div
                className="h-full rounded-full bg-neutral-900 transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !userDetails) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-5 max-w-xs text-center px-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-200">
            <svg
              className="h-5 w-5 text-neutral-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
              />
            </svg>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold text-neutral-900">
              Unable to load dashboard
            </h2>
            <p className="text-sm text-neutral-500">
              {error ? error.message : "Something went wrong. Please try again."}
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-1 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
          >
            Refresh page
          </button>
        </div>
      </div>
    );
  }

  // This return statement will only be shown briefly before redirection
  return null;
}
