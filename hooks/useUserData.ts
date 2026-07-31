"use client";

import { useState, useEffect } from "react";
import { reportError } from "@/lib/observability/report";
import { useToast } from "@/components/ui/use-toast";
import { TConsultantProfile } from "@/types/consultant";
import { TConsulteeProfile } from "@/types/consultee";
import { TStaffProfile } from "@/types/staff";
import { User, ConsultantReview } from "@prisma/client";
import {
  fetchUserDetails,
  fetchConsultantDetails,
  fetchConsulteeDetails,
  fetchStaffDetails,
  fetchReviews,
} from "@/lib/user";

export const useUserData = (userId: string) => {
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [profileDetails, setProfileDetails] = useState<
    TConsultantProfile | TConsulteeProfile | TStaffProfile | null
  >(null);
  const [reviews, setReviews] = useState<ConsultantReview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchUserInfo = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const userData = await fetchUserDetails(userId);
        setUserDetails(userData);

        switch (userData.role) {
          case "CONSULTANT":
            if (userData.consultantProfileId) {
              const consultantData = await fetchConsultantDetails(
                userData.consultantProfileId,
              );
              setProfileDetails(consultantData);
              const reviewsData = await fetchReviews(
                userData.consultantProfileId,
              );
              setReviews(reviewsData);
            }
            break;
          case "CONSULTEE":
            if (userData.consulteeProfileId) {
              const consulteeData = await fetchConsulteeDetails(
                userData.consulteeProfileId,
              );
              setProfileDetails(consulteeData);
            }
            break;
          case "STAFF":
            if (userData.staffProfileId) {
              const staffData = await fetchStaffDetails(
                userData.staffProfileId,
              );
              setProfileDetails(staffData);
            }
            break;
          default:
            // Handle other roles or no role
            break;
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        // 401 is expected after sign-out (session cleared before component unmounts)
        if (err !== null && err !== undefined && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) return;
        reportError(error, { subsystem: "client" });
        console.error("Error fetching user details:", err);
        toast({
          title: "Error fetching user details",
          description: error.message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    if (userId) {
      fetchUserInfo();
    }
  }, [userId, toast]);

  return { userDetails, profileDetails, reviews, isLoading, error };
};
