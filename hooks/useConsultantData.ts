import { useState, useEffect } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { TConsultantProfile } from '@/types/consultant';
import {User,ConsultantReview} from '@prisma/client'

export const fetchConsultantDetails = async (consultantId: string): Promise<TConsultantProfile> => {
  const response = await fetch(`/api/user/consultants/${consultantId}`);
  if (!response.ok) throw new Error('Failed to fetch consultant details');
  return await response.json();
};

export const fetchUserDetails = async (userId: string): Promise<User> => {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) throw new Error('Failed to fetch user details');
  const userData: { data: User } = await response.json();
  return userData.data;
};

export const fetchReviews = async (consultantId: string): Promise<ConsultantReview[]> => {
  const response = await fetch(`/api/user/reviews?consultantId=${consultantId}`);
  if (!response.ok) throw new Error('Failed to fetch reviews');
  return await response.json();
};

export const useConsultantData = (consultantId: string) => {
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [consultantDetails, setConsultantDetails] = useState<TConsultantProfile | null>(null);
  const [reviews, setReviews] = useState<ConsultantReview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    const fetchConsultantAndUserInfo = async () => {
      setIsLoading(true);
      try {
        const consultantData = await fetchConsultantDetails(consultantId);
        const userData = await fetchUserDetails(consultantData.userId);
        const reviewsData = await fetchReviews(consultantId);
        
        setConsultantDetails(consultantData);
        setUserDetails(userData);
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
        setReviews([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchConsultantAndUserInfo();
  }, [consultantId, toast]);

  return { userDetails, consultantDetails, reviews, isLoading };
};