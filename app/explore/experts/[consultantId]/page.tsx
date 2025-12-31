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
import { motion } from "framer-motion";
import { ArrowLeft, Users } from "lucide-react";
import { AboutSection } from "./components/AboutSection";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { ConsultantAvailability } from "./components/ConsultantAvailability";
import { ConsultantSkeletonLoader } from "./components/ConsultantSkeletonLoader";
import { ExpertPricing } from "./components/ExpertPricing";
import { ProfileHeader } from "./components/ProfileHeader";
import { ReviewsSection } from "./components/ReviewsSection";
import { useTimezone } from "./hooks/useTimezone";
import { format as formatTz } from "date-fns-tz";

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
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [slotTimings, setSlotTimings] = useState<TSlotTiming[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TSlotTiming | null>(null);
  const { toast } = useToast();

  const timezone = browserTimezone || userDetails?.timezone;

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
          const selectedDateKey = formatTz(selectedDate, "yyyy-MM-dd", {
            timeZone: timezone,
          });
          const slotsForSelectedDate = data[selectedDateKey] || [];
          setSlotTimings(slotsForSelectedDate);
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

    const startTime = new Date(selectedSlot.slotStartTimeInUTC);
    const endTime = new Date(selectedSlot.slotEndTimeInUTC);
    const durationInHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    const activePlan = consultantDetails.consultationPlans.find(
      (plan) => plan.durationInHours === durationInHours,
    );

    if (!activePlan) {
      toast({ title: "Invalid consultation plan", variant: "destructive" });
      return;
    }

    const params = new URLSearchParams();
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
    window.location.href = checkoutUrl;
  }, [selectedSlot, consultantDetails, toast]);

  const handleSubscriptionBooking = useCallback(
    async (
      option: {
        title: string;
        price: number;
        duration: string;
        durationInMonths?: number;
      },
      schedulingPeriod: { startDate: Date; endDate: Date },
    ) => {
      if (!consultantDetails) {
        toast({
          title: "Consultant details not found",
          variant: "destructive",
        });
        return;
      }

      const activePlan = consultantDetails.subscriptionPlans.find(
        (plan) => plan.durationInMonths === option.durationInMonths,
      );

      if (!activePlan) {
        toast({ title: "Invalid subscription plan", variant: "destructive" });
        return;
      }

      const schedulingPeriodStartsAt = schedulingPeriod.startDate.toISOString();
      const schedulingPeriodEndsAt = schedulingPeriod.endDate.toISOString();

      const params = new URLSearchParams({
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
      });
      window.location.href = `/checkout/plans/subscription/${activePlan.id}?${params.toString()}`;
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

    const adjustedFirstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
    const days = [];

    for (let i = 0; i < adjustedFirstDay; i++) {
      days.push(
        <div key={`empty-${i}`} className="w-10 h-10 lg:w-11 lg:h-11"></div>,
      );
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
      );
      const isSelected =
        selectedDate?.getDate() === i &&
        selectedDate?.getMonth() === currentDate.getMonth() &&
        selectedDate?.getFullYear() === currentDate.getFullYear();

      days.push(
        <button
          key={i}
          className={`w-10 h-10 lg:w-11 lg:h-11 rounded-full text-base font-medium transition-all duration-200 flex items-center justify-center
            ${
              isSelected
                ? "bg-white text-zinc-900 shadow-md"
                : "text-zinc-300 hover:bg-zinc-700/60"
            }`}
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
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
        <motion.div
          className="text-center max-w-md"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
        >
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-zinc-200 flex items-center justify-center">
            <Users className="w-10 h-10 text-zinc-400" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 mb-3">
            Expert Not Found
          </h1>
          <p className="text-zinc-500 mb-8">
            We couldn&apos;t find this expert. They may have moved or the link
            might be incorrect.
          </p>
          <Link href="/explore/experts">
            <Button className="bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl px-6">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Browse All Experts
            </Button>
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50">
      {/* Back Navigation */}
      <div className="bg-white border-b border-zinc-200">
        <div className="w-full px-4 md:px-8 lg:px-12 py-4">
          <Link
            href="/explore/experts"
            className="inline-flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Experts
          </Link>
        </div>
      </div>

      {/* Main Content Area - Profile, About, Availability + Pricing */}
      <div className="w-full px-4 md:px-8 lg:px-12 py-8 md:py-12">
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          {/* Main Content */}
          <motion.div
            className="flex-1 min-w-0"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
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
                timezone={timezone || "UTC"}
              />
            </div>
          </motion.div>

          {/* Sidebar - Pricing */}
          <motion.div
            className="w-full xl:w-[450px] 2xl:w-[500px] flex-shrink-0"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <ExpertPricing
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
              timezone={timezone || "UTC"}
            />
          </motion.div>
        </div>
      </div>

      {/* Classes & Webinars - Below main content only, not under pricing */}
      <div className="w-full px-4 md:px-8 lg:px-12 pb-8">
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          <motion.div
            className="flex-1 min-w-0"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <ClassesAndWebinars
              classPlans={consultantDetails.classPlans}
              webinarPlans={consultantDetails.webinarPlans}
            />
          </motion.div>
          {/* Spacer to match pricing sidebar width */}
          <div className="hidden xl:block w-[450px] 2xl:w-[500px] flex-shrink-0" />
        </div>
      </div>

      {/* Reviews - Below main content only, not under pricing */}
      <div className="w-full px-4 md:px-8 lg:px-12 pb-12">
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          <motion.div
            className="flex-1 min-w-0"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <ReviewsSection reviews={reviews} />
          </motion.div>
          {/* Spacer to match pricing sidebar width */}
          <div className="hidden xl:block w-[450px] 2xl:w-[500px] flex-shrink-0" />
        </div>
      </div>
    </main>
  );
}
