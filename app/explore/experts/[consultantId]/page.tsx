"use client";

import { useToast } from "@/components/ui/use-toast";
import {
  fetchConsultantDetails,
  fetchReviews,
  fetchUserDetails,
} from "@/hooks/useUserData";
import { ConsultantReview, User } from "@prisma/client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import { useTimezone } from "./hooks/useTimezone";
import { ConsultantSkeletonLoader } from "./components/ConsultantSkeletonLoader";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { ProfileHeader } from "./components/ProfileHeader";
import { AboutSection } from "./components/AboutSection";
import { ConsultantAvailability } from "./components/ConsultantAvailability";
import { ReviewsSection } from "./components/ReviewsSection";
import { ConsultationPricing } from "./components/ConsultationPricing";
import {
  normalizeWeeklySlot,
  normalizeCustomSlot,
  createWeeklySlot,
  createCustomSlot,
  mergeOverlappingSlots,
  getLocalDay,
  isSameLocalDay,
  dayMap,
  convertUTCToLocalDate,
} from "./utils";

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
    // Only process slots if timezone is available and not loading
    if (selectedDate && consultantDetails && timezone && !isTimezoneLoading) {
      console.log("Using timezone:", timezone);
      console.log("Selected date:", selectedDate.toISOString());

      if (consultantDetails.scheduleType === "WEEKLY") {
        const selectedDay = dayMap[getLocalDay(selectedDate, timezone)];
        console.log("Selected day:", selectedDay);

        // Get slots for the selected day
        const relevantSlots = consultantDetails.slotsOfAvailabilityWeekly
          .map(normalizeWeeklySlot)
          .filter((slot) => slot.dayOfWeekforStartTimeInUTC === selectedDay);

        const weeklySlots = relevantSlots.map((slot) => {
          // Convert UTC times to local date objects
          const startDateTime = convertUTCToLocalDate(
            slot.slotStartTimeInUTC,
            selectedDate,
            timezone,
          );
          let endDateTime = convertUTCToLocalDate(
            slot.slotEndTimeInUTC,
            selectedDate,
            timezone,
          );

          console.log("Processing slot:", {
            utcStart: slot.slotStartTimeInUTC,
            utcEnd: slot.slotEndTimeInUTC,
            localStart: startDateTime.toISOString(),
            localEnd: endDateTime.toISOString(),
            timezone,
          });

          // Create the slot timing
          return createWeeklySlot(
            slot,
            selectedDate,
            startDateTime,
            endDateTime,
            timezone,
          );
        });

        // Sort slots by start time
        const sortedSlots = weeklySlots.sort(
          (a, b) =>
            new Date(a.slotStartTimeInUTC).getTime() -
            new Date(b.slotStartTimeInUTC).getTime(),
        );

        // Merge overlapping slots
        const mergedSlots = mergeOverlappingSlots(sortedSlots, timezone);
        console.log(
          "Final slots:",
          mergedSlots.map((slot) => ({
            start: slot.localStartTime,
            end: slot.localEndTime,
          })),
        );
        setSlotTimings(mergedSlots);
      } else if (consultantDetails.scheduleType === "CUSTOM") {
        const customSlots = consultantDetails.slotsOfAvailabilityCustom
          .map(normalizeCustomSlot)
          .filter((slot) => {
            const startDateTime = new Date(slot.slotStartTimeInUTC);
            return isSameLocalDay(startDateTime, selectedDate, timezone);
          })
          .map((slot) => {
            const startDateTime = new Date(slot.slotStartTimeInUTC);
            const endDateTime = new Date(slot.slotEndTimeInUTC);
            return createCustomSlot(
              slot,
              selectedDate,
              startDateTime,
              endDateTime,
              timezone,
            );
          });

        // Sort slots by start time
        const sortedSlots = customSlots.sort(
          (a, b) =>
            new Date(a.slotStartTimeInUTC).getTime() -
            new Date(b.slotStartTimeInUTC).getTime(),
        );

        setSlotTimings(sortedSlots);
      }
    } else {
      // Clear slots if timezone is not available
      setSlotTimings([]);
    }
  }, [selectedDate, consultantDetails, timezone, isTimezoneLoading]);

  const handleBooking = useCallback(async () => {
    if (!selectedSlot) {
      toast({ title: "Please select a time slot", variant: "destructive" });
      return;
    }

    try {
      const response = await fetch("/api/book-consultation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consultantId: params.consultantId,
          slotId: selectedSlot.slotId,
          date: selectedDate,
        }),
      });

      if (response.ok) {
        toast({ title: "Booking request sent successfully" });
      } else {
        toast({
          title: "Failed to send booking request",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Booking error:", error);
      toast({ title: "An error occurred", variant: "destructive" });
    }
  }, [selectedSlot, params.consultantId, selectedDate, toast]);

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
        handleBooking={handleBooking}
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
