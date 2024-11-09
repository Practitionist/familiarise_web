"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import {
  fetchConsultantDetails,
  fetchReviews,
  fetchUserDetails,
} from "@/hooks/useUserData";

import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import {
  ConsultantReview,
  ConsultationPlan,
  SubscriptionPlan,
  User,
} from "@prisma/client";
import { StarIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { ClassesAndWebinars } from "./ClassesAndWebinars";
import { ConsultantSkeletonLoader } from "./ConsultantSkeletonLoader";
import { CustomAvailability } from "./CustomAvailability";
import PricingToggle from "./PricingToggle";
import Review from "./Review";
import { WeeklyAvailability } from "./WeeklyAvailability";

interface PricingOption {
  title: string;
  description: string;
  price: number;
  duration: string;
  features?: string[];
}

type Params = Promise<{ consultantId: string }>;
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function ExpertProfile(
  props: Readonly<{
    params: Params;
    searchParams: SearchParams;
  }>,
) {
  const params = use(props.params);
  const searchParams = use(props.searchParams);

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

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const consultantData = await fetchConsultantDetails(
          params.consultantId,
        );
        setConsultantDetails(consultantData);
        console.log(consultantData);
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
    if (selectedDate && consultantDetails) {
      if (consultantDetails.scheduleType === "WEEKLY") {
        // For weekly schedule, use the slots directly from consultantDetails
        const weeklySlots = consultantDetails.slotsOfAvailabilityWeekly.map(
          (slot) => {
            // Extract time from the ISO string and ensure it's a string
            const startTimeStr =
              typeof slot.slotStartTimeInUTC === "string"
                ? slot.slotStartTimeInUTC
                : new Date(slot.slotStartTimeInUTC).toISOString();
            const endTimeStr =
              typeof slot.slotEndTimeInUTC === "string"
                ? slot.slotEndTimeInUTC
                : new Date(slot.slotEndTimeInUTC).toISOString();

            return {
              slotId: slot.id,
              dateInISO: selectedDate.toISOString(),
              slotStartTimeInUTC: startTimeStr,
              slotEndTimeInUTC: endTimeStr,
              slotOfAvailabilityId: slot.id,
              slotOfAppointmentId: "",
              localStartTime: startTimeStr,
              localEndTime: endTimeStr,
            };
          },
        );
        setSlotTimings(weeklySlots);
      } else if (consultantDetails.scheduleType === "CUSTOM") {
        // For custom schedule, use the custom slots from consultantDetails
        const customSlots = consultantDetails.slotsOfAvailabilityCustom
          .filter((slot) => {
            const slotDate = new Date(
              typeof slot.slotStartTimeInUTC === "string"
                ? slot.slotStartTimeInUTC
                : slot.slotStartTimeInUTC,
            );
            return slotDate.toDateString() === selectedDate.toDateString();
          })
          .map((slot) => ({
            slotId: slot.id,
            dateInISO: selectedDate.toISOString(),
            slotStartTimeInUTC:
              typeof slot.slotStartTimeInUTC === "string"
                ? slot.slotStartTimeInUTC
                : new Date(slot.slotStartTimeInUTC).toISOString(),
            slotEndTimeInUTC:
              typeof slot.slotEndTimeInUTC === "string"
                ? slot.slotEndTimeInUTC
                : new Date(slot.slotEndTimeInUTC).toISOString(),
            slotOfAvailabilityId: slot.id,
            slotOfAppointmentId: "",
            localStartTime:
              typeof slot.slotStartTimeInUTC === "string"
                ? slot.slotStartTimeInUTC
                : new Date(slot.slotStartTimeInUTC).toISOString(),
            localEndTime:
              typeof slot.slotEndTimeInUTC === "string"
                ? slot.slotEndTimeInUTC
                : new Date(slot.slotEndTimeInUTC).toISOString(),
          }));
        setSlotTimings(customSlots);
      }
    }
  }, [selectedDate, consultantDetails]);

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

  const renderAvailability = useMemo(() => {
    if (!consultantDetails) return null;

    if (consultantDetails.scheduleType === "WEEKLY") {
      // Convert Date objects to strings for weekly slots
      const weeklySlots = consultantDetails.slotsOfAvailabilityWeekly.map(
        (slot) => ({
          id: slot.id,
          dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
          slotStartTimeInUTC:
            typeof slot.slotStartTimeInUTC === "string"
              ? slot.slotStartTimeInUTC
              : slot.slotStartTimeInUTC.toISOString(),
          dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
          slotEndTimeInUTC:
            typeof slot.slotEndTimeInUTC === "string"
              ? slot.slotEndTimeInUTC
              : slot.slotEndTimeInUTC.toISOString(),
        }),
      );

      return (
        <WeeklyAvailability
          slots={weeklySlots}
          onSlotSelect={(slot) =>
            setSelectedSlot({
              slotId: slot.id,
              dateInISO: new Date().toISOString(),
              slotStartTimeInUTC: slot.slotStartTimeInUTC,
              slotEndTimeInUTC: slot.slotEndTimeInUTC,
              slotOfAvailabilityId: slot.id,
              slotOfAppointmentId: "",
              localStartTime: new Date(
                `1970-01-01T${slot.slotStartTimeInUTC}`,
              ).toISOString(),
              localEndTime: new Date(
                `1970-01-01T${slot.slotEndTimeInUTC}`,
              ).toISOString(),
            })
          }
          selectedSlotId={selectedSlot?.slotId}
        />
      );
    } else if (consultantDetails.scheduleType === "CUSTOM") {
      // Convert Date objects to strings for custom slots
      const customSlots = consultantDetails.slotsOfAvailabilityCustom.map(
        (slot) => ({
          id: slot.id,
          slotStartTimeInUTC:
            typeof slot.slotStartTimeInUTC === "string"
              ? slot.slotStartTimeInUTC
              : slot.slotStartTimeInUTC.toISOString(),
          slotEndTimeInUTC:
            typeof slot.slotEndTimeInUTC === "string"
              ? slot.slotEndTimeInUTC
              : slot.slotEndTimeInUTC.toISOString(),
        }),
      );

      return (
        <CustomAvailability
          slots={customSlots}
          onSlotSelect={(slot) =>
            setSelectedSlot({
              slotId: slot.id,
              dateInISO: new Date(slot.slotStartTimeInUTC).toISOString(),
              slotStartTimeInUTC: slot.slotStartTimeInUTC,
              slotEndTimeInUTC: slot.slotEndTimeInUTC,
              slotOfAvailabilityId: slot.id,
              slotOfAppointmentId: "",
              localStartTime: new Date(slot.slotStartTimeInUTC).toISOString(),
              localEndTime: new Date(slot.slotEndTimeInUTC).toISOString(),
            })
          }
          selectedSlotId={selectedSlot?.slotId}
        />
      );
    }
    return null;
  }, [consultantDetails, selectedSlot]);
  const isConsultationPlan = (
    plan: ConsultationPlan | SubscriptionPlan,
  ): plan is ConsultationPlan => {
    return "durationInHours" in plan;
  };

  const isSubscriptionPlan = (
    plan: ConsultationPlan | SubscriptionPlan,
  ): plan is SubscriptionPlan => {
    return "durationInMonths" in plan;
  };

  const formatPricingOptions = useCallback(
    (
      plans: (ConsultationPlan | SubscriptionPlan)[],
      type: "consultation" | "subscription",
    ): PricingOption[] => {
      return plans.map((plan) => {
        if (type === "consultation" && isConsultationPlan(plan)) {
          return {
            title: `${plan.durationInHours} Hour${plan.durationInHours > 1 ? "s" : ""}`,
            description: `${plan.durationInHours} hour consultation`,
            price: plan.price,
            duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
          };
        } else if (type === "subscription" && isSubscriptionPlan(plan)) {
          return {
            title: `${plan.durationInMonths} Month${plan.durationInMonths > 1 ? "s" : ""}`,
            description: `${plan.durationInMonths} month subscription`,
            price: plan.price,
            duration: `${plan.durationInMonths} month${plan.durationInMonths > 1 ? "s" : ""}`,
            features: [
              `${plan.callsPerWeek} call${plan.callsPerWeek > 1 ? "s" : ""} per week`,
              `${plan.videoMeetings} video meeting${plan.videoMeetings > 1 ? "s" : ""}`,
              `${plan.emailSupport} email support`,
            ],
          };
        }
        return {
          title: "",
          description: "",
          price: 0,
          duration: "",
        };
      });
    },
    [],
  );

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

  const consultationOptions = formatPricingOptions(
    consultantDetails.consultationPlans,
    "consultation",
  );
  const subscriptionOptions = formatPricingOptions(
    consultantDetails.subscriptionPlans,
    "subscription",
  );

  return (
    <div key={params.consultantId} className="flex justify-center py-40">
      <div className="flex flex-col w-1/2">
        <div className="space-y-8">
          <div className="flex items-center space-x-6">
            <div className="flex flex-col">
              <h2 className="text-3xl font-semibold">{userDetails.name}</h2>
              <div className="flex items-center mt-2">
                {[...Array(5)].map((_, i) => (
                  <StarIcon
                    key={`${i}-${consultantDetails.rating}`}
                    className={`w-5 h-5 ${i < consultantDetails.rating ? "text-blue-500" : "text-gray-300"}`}
                  />
                ))}
                <span className="ml-2 text-sm text-gray-600">
                  ({consultantDetails.rating})
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <Badge variant="outline">{consultantDetails.specialization}</Badge>
            <div>
              <h3 className="text-xl font-semibold mb-2">About</h3>
              <p className="text-gray-600">
                {userDetails.name} is a seasoned{" "}
                {consultantDetails.specialization} with{" "}
                {consultantDetails.experience} of experience in the{" "}
                {consultantDetails.domain.name} sector.
              </p>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-2">
                Expertise and Education
              </h3>
              <p className="text-gray-600">
                {userDetails.name}'s expertise spans multiple industries, with a
                particular focus on {consultantDetails?.subDomains.join(", ")}.
              </p>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-2">
                Client Testimonials
              </h3>
              <p className="text-gray-600">
                Clients commend {userDetails.name} for their strategic insights
                and result-oriented approach.
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-4">
              Consultant Availability
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              {consultantDetails.scheduleType === "WEEKLY"
                ? "Weekly schedule. Select a time slot to schedule a meeting."
                : "Custom schedule for the next 7 days. Select a time slot to schedule a meeting."}
            </p>
            {renderAvailability}
          </div>
        </div>
        <ClassesAndWebinars
          classPlans={consultantDetails.classPlans}
          webinarPlans={consultantDetails.webinarPlans}
        />
        <div>
          <h3 className="font-semibold text-lg mb-4">
            All Reviews ({reviews?.length || 0})
          </h3>
          <div className="space-y-4">
            {reviews && reviews.length > 0 ? (
              reviews.map((review) => <Review key={review.id} {...review} />)
            ) : (
              <p>No reviews available.</p>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-col items-center w-1/4 ml-10">
        <Image
          alt="Profile"
          className="rounded-full mb-6"
          height="1350"
          src={userDetails.image || "/placeholder.svg"}
          style={{
            aspectRatio: "1080/1350",
            objectFit: "cover",
          }}
          width="1080"
        />
        <div className="card p-6 bg-white shadow-lg rounded-lg w-full">
          <h3 className="text-lg font-semibold mb-4">Consultation Pricing</h3>
          <PricingToggle
            consultationOptions={consultationOptions}
            subscriptionOptions={subscriptionOptions}
            consultantDetails={consultantDetails}
            userDetails={userDetails}
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
      </div>
    </div>
  );
}
