import { useState, useEffect } from "react";
import { useToast } from "@/components/ui/use-toast";
import { TConsultantProfile } from "@/types/consultant";
import { TConsulteeProfile } from "@/types/consultee";
import { TStaffProfile } from "@/types/staff";
import { User, ConsultantReview } from "@prisma/client";

export const fetchUserDetails = async (userId: string): Promise<User> => {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok)
    throw new Error(`Failed to fetch user details: ${response.statusText}`);
  const userData: { data: User } = await response.json();
  return userData.data;
};

export const fetchConsultantDetails = async (
  consultantId: string,
): Promise<TConsultantProfile> => {
  const response = await fetch(`/api/user/consultants/${consultantId}`);
  if (!response.ok)
    throw new Error(
      `Failed to fetch consultant details: ${response.statusText}`,
    );
  const consultantData: { data: TConsultantProfile } = await response.json();
  return consultantData.data;
};

export const fetchConsulteeDetails = async (
  consulteeId: string,
): Promise<TConsulteeProfile> => {
  const response = await fetch(`/api/user/consultees/${consulteeId}`);
  if (!response.ok)
    throw new Error(
      `Failed to fetch consultee details: ${response.statusText}`,
    );
  const consulteeData: { data: TConsulteeProfile } = await response.json();
  return consulteeData.data;
};

export const fetchStaffDetails = async (
  staffId: string,
): Promise<TStaffProfile> => {
  const response = await fetch(`/api/user/staff/${staffId}`);
  if (!response.ok)
    throw new Error(`Failed to fetch staff details: ${response.statusText}`);
  const staffData: { data: TStaffProfile } = await response.json();
  return staffData.data;
};

export const fetchReviews = async (
  consultantId: string,
): Promise<ConsultantReview[]> => {
  const response = await fetch(
    `/api/user/reviews?consultantId=${consultantId}`,
  );
  if (!response.ok)
    throw new Error(`Failed to fetch reviews: ${response.statusText}`);
  const reviewsData: { data: ConsultantReview[] } = await response.json();
  return reviewsData.data;
};

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
      } catch (err: any) {
        console.error("Error fetching user details:", err);
        setError(err);
        toast({
          title: "Error fetching user details",
          description: err.message,
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
