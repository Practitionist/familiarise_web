import { useState, useEffect } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { TConsultantProfile, TUserDetails, TConsultantReview } from './types';

export const useConsultantData = (consultantId: string) => {
  const [userDetails, setUserDetails] = useState<TUserDetails | null>(null);
  const [consultantDetails, setConsultantDetails] = useState<TConsultantProfile | null>(null);
  const [reviews, setReviews] = useState<TConsultantReview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    const fetchConsultantAndUserInfo = async () => {
      setIsLoading(true);
      try {
        const consultantResponse = await fetch(`/api/user/consultants/${consultantId}`);
        if (!consultantResponse.ok) throw new Error('Failed to fetch consultant details');
        const consultantData: TConsultantProfile = await consultantResponse.json();
        setConsultantDetails(consultantData);

        const userResponse = await fetch(`/api/user/${consultantData.userId}`);
        if (!userResponse.ok) throw new Error('Failed to fetch user details');
        const userData: { data: TUserDetails } = await userResponse.json();
        setUserDetails(userData.data);
        
        const reviewsResponse = await fetch(`/api/user/reviews?consultantId=${consultantId}`);
        if (!reviewsResponse.ok) throw new Error('Failed to fetch reviews');
        const reviewsData: TConsultantReview[] = await reviewsResponse.json();
        setReviews(reviewsData);
      
      } catch (error: any) {
        console.error("Error fetching consultant details:", error);
        toast({
          title: "Error fetching consultant details",
          description: error.message,
          variant: "destructive",
        });
        setConsultantDetails(null);
        setUserDetails(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchConsultantAndUserInfo();
  }, [consultantId, toast]);

  return { userDetails, consultantDetails, reviews, isLoading };
};