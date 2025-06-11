"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import {
  fetchConsultantDetails,
  fetchReviews,
  fetchUserDetails,
} from "@/lib/user";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import { ConsultantReview, User } from "@prisma/client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { AboutSection } from "./components/AboutSection";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { ConsultantAvailability } from "./components/ConsultantAvailability";
import { ConsultantSkeletonLoader } from "./components/ConsultantSkeletonLoader";
import { ConsultationPricing } from "./components/ConsultationPricing";
import { ProfileHeader } from "./components/ProfileHeader";
import { ReviewsSection } from "./components/ReviewsSection";
import { useTimezone } from "./hooks/useTimezone";

type Params = Promise<{ consultantId: string }>;
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function ExpertProfile(
  props: Readonly<{
    params: Params;
    searchParams: SearchParams;
  }>,
) {
  const params = use(props.params);
  const { timezone: browserTimezone, isLoading: isTimezoneLoading } =
    useTimezone();

  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [consultantDetails, setConsultantDetails] =
    useState<TConsultantProfile | null>(null);
  const [reviews, setReviews] = useState<ConsultantReview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [slotTimings, setSlotTimings] = useState<TSlotTiming[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TSlotTiming | null>(null);
  const { toast } = useToast();

  // Prioritize browser timezone over user timezone
  const timezone = browserTimezone || userDetails?.currentTimezone;

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const consultantData = await fetchConsultantDetails(
          params.consultantId,
        );
        setConsultantDetails(consultantData);
        if (consultantData.userId) {
          const userData = await fetchUserDetails(consultantData.userId);
          setUserDetails(userData);
          const reviewsData = await fetchReviews(params.consultantId);
          setReviews(reviewsData);
        } else {
          throw new Error("Consultant user ID not found");
        }
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(
          err instanceof Error ? err : new Error("An unknown error occurred"),
        );
        toast({
          title: "Error fetching data",
          description:
            err instanceof Error ? err.message : "An unknown error occurred",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [params.consultantId, toast]);

  useEffect(() => {
    async function fetchSlots() {
      if (selectedDate && consultantDetails && timezone && !isTimezoneLoading) {
        try {
          console.log("Using timezone:", timezone);
          console.log("Selected date:", selectedDate.toISOString());

          const startDateInUtc = new Date(selectedDate);
          startDateInUtc.setHours(0, 0, 0, 0);
          const endDateInUtc = new Date(selectedDate);
          endDateInUtc.setHours(23, 59, 59, 999);

          const response = await fetch(
            `/api/slots/availability-with-allocation/${
              consultantDetails.id
            }?startDateInUtc=${startDateInUtc.toISOString()}&endDateInUtc=${endDateInUtc.toISOString()}&timezone=${timezone}`,
          );

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(
              errorData.error || "Failed to fetch availability slots",
            );
          }

          const { data } = await response.json();
          const dateKey = Object.keys(data)[0];
          const slotsForDay = dateKey ? data[dateKey] : [];
          setSlotTimings(slotsForDay);
        } catch (error) {
          console.error("Error fetching slots:", error);
          toast({
            title: "Error fetching slots",
            description:
              error instanceof Error ? error.message : "Please try again",
            variant: "destructive",
          });
        }
      } else {
        // Clear slots if timezone is not available
        setSlotTimings([]);
      }
    }

    fetchSlots();
  }, [selectedDate, consultantDetails, timezone, isTimezoneLoading, toast]);

  const handleConsultationBooking = useCallback(async () => {
    if (!selectedSlot || !consultantDetails) {
      toast({ title: "Please select a time slot", variant: "destructive" });
      return;
    }

    // Calculate duration in hours from slot times
    const startTime = new Date(selectedSlot.slotStartTimeInUTC);
    const endTime = new Date(selectedSlot.slotEndTimeInUTC);
    const durationInHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    // Get the active consultation plan
    const activePlan = consultantDetails.consultationPlans.find(
      (plan) => plan.durationInHours === durationInHours,
    );

    if (!activePlan) {
      toast({ title: "Invalid consultation plan", variant: "destructive" });
      return;
    }

    // Construct URL with necessary params
    const params = new URLSearchParams();

    // Add the original slot ID and the selected time window
    const slotStartTimeInUTC = new Date(selectedSlot.slotStartTimeInUTC);
    const slotEndTimeInUTC = new Date(selectedSlot.slotEndTimeInUTC);

    if (
      (selectedSlot as TSlotTiming & { type: "WEEKLY" | "CUSTOM" }).type ===
      "WEEKLY"
    ) {
      params.append(
        "slotOfAvailabilityWeeklyId",
        selectedSlot.slotOfAvailabilityId,
      );
    } else {
      params.append(
        "slotOfAvailabilityCustomId",
        selectedSlot.slotOfAvailabilityId,
      );
    }
    params.append("slotStartTimeInUTC", slotStartTimeInUTC.toISOString());
    params.append("slotEndTimeInUTC", slotEndTimeInUTC.toISOString());

    const checkoutUrl = `/checkout/plans/consultation/${activePlan.id}?${params.toString()}`;

    // Redirect to checkout page
    window.location.href = checkoutUrl;
  }, [selectedSlot, consultantDetails, params.consultantId, toast]);

  const handleSubscriptionBooking = useCallback(
    async (option: { title: string; price: number; duration: string }) => {
      if (!consultantDetails) {
        toast({
          title: "Consultant details not found",
          variant: "destructive",
        });
        return;
      }

      // Get the active subscription plan
      const activePlan = consultantDetails.subscriptionPlans.find(
        (plan) => plan.durationInMonths === parseInt(option.duration),
      );

      if (!activePlan) {
        toast({ title: "Invalid subscription plan", variant: "destructive" });
        return;
      }

      // Redirect to subscription checkout page
      window.location.href = `/checkout/plans/subscription/${activePlan.id}`;
    },
    [consultantDetails, toast],
  );

  const renderCalendar = useCallback(() => {
    const daysInMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() + 1,
      0,
    ).getDate();
    const firstDayOfMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      1,
    ).getDay();
    const days = [];

    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
      );
      days.push(
        <button
          key={i}
          className={`p-2 rounded-full hover:bg-white hover:bg-opacity-20 
            ${selectedDate?.getDate() === i ? "bg-white text-black" : ""}`}
          onClick={() => {
            setSelectedDate(date);
            setSelectedSlot(null);
          }}
        >
          {i}
        </button>,
      );
    }

    return days;
  }, [currentDate, selectedDate]);

  if (isLoading) {
    return <ConsultantSkeletonLoader />;
  }

  if (error || !consultantDetails || !userDetails) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <h1 className="text-3xl font-bold mb-4">Oops! Consultant not found</h1>
        <p className="text-lg mb-6">
          Here are some other consultants you might want to try out
        </p>
        <Link href="/search">
          <Button variant="night" className="rounded-full">
            Search Consultants
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div key={params.consultantId} className="flex justify-center py-40">
      <div className="flex flex-col w-1/2">
        <div className="space-y-8">
          <ProfileHeader
            userDetails={userDetails}
            consultantDetails={consultantDetails}
          />

          <AboutSection
            userDetails={userDetails}
            consultantDetails={consultantDetails}
          />

          <ConsultantAvailability
            consultantDetails={consultantDetails}
            selectedSlot={selectedSlot}
            setSelectedSlot={setSelectedSlot}
            timezone={timezone || "UTC"}
          />
        </div>

        <ClassesAndWebinars
          classPlans={consultantDetails.classPlans}
          webinarPlans={consultantDetails.webinarPlans}
        />

        <ReviewsSection reviews={reviews} />
      </div>

      <ConsultationPricing
        userDetails={userDetails}
        consultantDetails={consultantDetails}
        handleConsultationBooking={handleConsultationBooking}
        handleSubscriptionBooking={handleSubscriptionBooking}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        currentDate={currentDate}
        setCurrentDate={setCurrentDate}
        renderCalendar={renderCalendar}
        slotTimings={slotTimings}
        selectedSlot={selectedSlot}
        setSelectedSlot={setSelectedSlot}
      />
    </div>
  );
}
