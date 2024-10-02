"use client";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { fetchConsultantDetails, fetchUserDetails, fetchReviews } from '@/hooks/useUserData';
import { TSlotTiming } from "@/lib/datetimetz";
import { ConsultantReview, User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import { StarIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClassesAndWebinars } from './ClassesAndWebinars';
import { ConsultantSkeletonLoader } from './ConsultantSkeletonLoader';
import PricingToggle from './PricingToggle';
import { TConsultantProfile } from '@/types/consultant';

interface PricingOption {
  title: string;
  description: string;
  price: number;
  duration: string;
  features?: string[];
}

const Review: React.FC<ConsultantReview> = ({ consulteeProfileId, createdAt, rating, reviewDescription }) => (
  <div className="flex items-start space-x-4 p-4 bg-white rounded-lg shadow-sm">
    <Avatar className="w-10 h-10" />
    <div className="flex-1">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h4 className="text-md font-semibold text-gray-800">{consulteeProfileId}</h4>
          <p className="text-xs text-gray-500">{new Date(createdAt).toLocaleDateString()}</p>
        </div>
        <div className="flex items-center">
          {[...Array(5)].map((_, i) => (
            <StarIcon
              key={i}
              className={`w-4 h-4 ${i < rating ? "text-yellow-400" : "text-gray-200"}`}
            />
          ))}
        </div>
      </div>
      <p className="text-sm text-gray-600 leading-relaxed">{reviewDescription}</p>
    </div>
  </div>
);

export default function ExpertProfile({ params }: { readonly params: { consultantId: string } }) {
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [consultantDetails, setConsultantDetails] = useState<TConsultantProfile | null>(null);
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
        const consultantData = await fetchConsultantDetails(params.consultantId);
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
        setError(err instanceof Error ? err : new Error('An unknown error occurred'));
        toast({
          title: "Error fetching data",
          description: err instanceof Error ? err.message : 'An unknown error occurred',
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [params.consultantId, toast]);

  const fetchSelectedDateSlotTimings = useCallback(async (consultantId: string, date: Date) => {
    const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const response = await fetch(
      `/api/slots/availability/${encodeURIComponent(consultantId)}?date=${encodeURIComponent(date.toISOString())}&timeZone=${encodeURIComponent(userTimeZone)}`
    );
    if (!response.ok) throw new Error("Failed to fetch available slots");
    return response.json();
  }, []);

  useEffect(() => {
    if (selectedDate && consultantDetails) {
      fetchSelectedDateSlotTimings(consultantDetails.id, selectedDate)
        .then(setSlotTimings)
        .catch((error) => {
          console.error("Error fetching slots:", error);
          toast({
            title: "Error fetching slots",
            description: error instanceof Error ? error.message : 'An unknown error occurred',
            variant: "destructive",
          });
        });
    }
  }, [selectedDate, consultantDetails, fetchSelectedDateSlotTimings, toast]);

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
    const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();
    const days = [];

    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), i);
      days.push(
        <button
          key={i}
          className={`p-2 rounded-full hover:bg-white hover:bg-opacity-20 
            ${selectedDate?.getDate() === i ? "bg-white text-black" : ""}`}
          onClick={() => {
            setSelectedDate(date);
            setSelectedSlot(null); // Reset selected slot when a new date is chosen
          }}
        >
          {i}
        </button>
      );
    }

    return days;
  }, [currentDate, selectedDate]);

  const renderAvailability = useMemo(() => {
    if (!consultantDetails) return null;

    const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    if (consultantDetails.scheduleType === 'WEEKLY') {
      return (
        <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
          <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">Weekly Availability</h3>
          <div className="grid grid-cols-7 gap-6 mb-6">
            {daysOfWeek.map((day) => (
              <div key={day} className="text-center text-sm font-semibold text-gray-700">{day}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-6">
            {daysOfWeek.map((day) => (
              <div key={day} className="space-y-3">
                {consultantDetails.slotsOfAvailabilityWeekly
                  .filter((slot) => slot.dayOfWeekforStartTimeInUTC === day.toUpperCase())
                  .map((slot) => {
                    const startTime = new Date(slot.slotStartTimeInUTC);
                    const endTime = new Date(slot.slotEndTimeInUTC);
                    return (
                      <div
                        key={slot.id}
                        className="bg-blue-50 rounded-md p-2 cursor-pointer hover:bg-blue-100 transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center"
                      >
                        <div className="text-xs font-medium text-blue-700">
                          {startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -
                          {endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      );
    } else if (consultantDetails.scheduleType === 'CUSTOM') {
      const today = new Date();
      const next7Days = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        return date;
      });

      return (
        <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
          <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">Custom Availability</h3>
          <div className="grid grid-cols-7 gap-6 mb-6">
            {next7Days.map((date) => (
              <div key={date.toISOString()} className="text-center">
                <div className="text-sm font-semibold text-gray-700">{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div className="text-xs text-gray-500">{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-6">
            {next7Days.map((date) => (
              <div key={date.toISOString()} className="space-y-3">
                {consultantDetails.slotsOfAvailabilityCustom
                  .filter((slot) => {
                    const slotDate = new Date(slot.slotStartTimeInUTC);
                    return slotDate.toDateString() === date.toDateString();
                  })
                  .map((slot) => {
                    const startTime = new Date(slot.slotStartTimeInUTC);
                    const endTime = new Date(slot.slotEndTimeInUTC);
                    return (
                      <div
                        key={slot.id}
                        className="bg-green-50 rounded-md p-2 cursor-pointer hover:bg-green-100 transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center"
                      >
                        <div className="text-xs font-medium text-green-700">
                          {startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -
                          {endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      );
    }

    return null;
  }, [consultantDetails]);

  const isConsultationPlan = (plan: ConsultationPlan | SubscriptionPlan): plan is ConsultationPlan => {
    return 'durationInHours' in plan;
  };

  const isSubscriptionPlan = (plan: ConsultationPlan | SubscriptionPlan): plan is SubscriptionPlan => {
    return 'durationInMonths' in plan;
  };

  const formatPricingOptions = useCallback((plans: (ConsultationPlan | SubscriptionPlan)[], type: 'consultation' | 'subscription'): PricingOption[] => {
    return plans.map(plan => {
      if (type === 'consultation' && isConsultationPlan(plan)) {
        return {
          title: `${plan.durationInHours} Hour${plan.durationInHours > 1 ? 's' : ''}`,
          description: `${plan.durationInHours} hour consultation`,
          price: plan.price,
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? 's' : ''}`,
        };
      } else if (type === 'subscription' && isSubscriptionPlan(plan)) {
        return {
          title: `${plan.durationInMonths} Month${plan.durationInMonths > 1 ? 's' : ''}`,
          description: `${plan.durationInMonths} month subscription`,
          price: plan.price,
          duration: `${plan.durationInMonths} month${plan.durationInMonths > 1 ? 's' : ''}`,
          features: [
            `${plan.callsPerWeek} call${plan.callsPerWeek > 1 ? 's' : ''} per week`,
            `${plan.videoMeetings} video meeting${plan.videoMeetings > 1 ? 's' : ''}`,
            `${plan.emailSupport} email support`
          ]
        };
      }
      // This should never happen, but TypeScript requires a return statement
      return {
        title: '',
        description: '',
        price: 0,
        duration: '',
      };
    });
  }, []);

  if (isLoading) {
    return <ConsultantSkeletonLoader />;
  }

  if (error || !consultantDetails || !userDetails) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <h1 className="text-3xl font-bold mb-4">Oops! Consultant not found</h1>
        <p className="text-lg mb-6">Here are some other consultants you might want to try out</p>
        <Link href="/search">
          <Button variant="night" className="rounded-full">Search Consultants</Button>
        </Link>
      </div>
    );
  }

  const consultationOptions = formatPricingOptions(consultantDetails.consultationPlans, 'consultation');
  const subscriptionOptions = formatPricingOptions(consultantDetails.subscriptionPlans, 'subscription');

  return (
    <div key={params.consultantId} className="flex justify-center py-40">
      <div className="flex flex-col w-1/2">
        <div className="space-y-8">
          <div className="flex items-center space-x-6">
            <div className="flex flex-col">
              <h2 className="text-3xl font-semibold">{userDetails.name}</h2>
              <div className="flex items-center mt-2">
                {[...Array(5)].map((_, i) => (
                  <StarIcon key={`${i}-${consultantDetails.rating}`} className={`w-5 h-5 ${i < consultantDetails.rating ? "text-blue-500" : "text-gray-300"}`} />
                ))}
                <span className="ml-2 text-sm text-gray-600">({consultantDetails.rating})</span>
              </div>
              <p className="text-lg text-gray-700 mt-1">{consultantDetails.subDomains.join(", ")}</p>
            </div>
          </div>

          <div className="space-y-6">
            
            <Badge variant="outline">{consultantDetails.specialization}</Badge>
            <div>
              <h3 className="text-xl font-semibold mb-2">About</h3>
              <p className="text-gray-600">
                {userDetails.name} is a seasoned {consultantDetails.specialization} with {consultantDetails.experience} of experience in the {consultantDetails.domain} sector.
              </p>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-2">Expertise and Education</h3>
              <p className="text-gray-600">
                {userDetails.name}'s expertise spans multiple industries, with a particular focus on {consultantDetails.subDomains.join(", ")}.
              </p>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-2">Client Testimonials</h3>
              <p className="text-gray-600">
                Clients commend {userDetails.name} for their strategic insights and result-oriented approach.
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-4">Consultant Availability</h3>
            <p className="text-sm text-gray-600 mb-4">
              {consultantDetails.scheduleType === 'WEEKLY'
                ? "Weekly schedule. Select a time slot to schedule a meeting."
                : "Custom schedule for the next 7 days. Select a time slot to schedule a meeting."}
            </p>
            {renderAvailability}
          </div>
        </div>
        <ClassesAndWebinars consultantId={params.consultantId} />
        <div>
          <h3 className="font-semibold text-lg mb-4">All Reviews ({reviews.length})</h3>
          <div className="space-y-4">
            {reviews.map((review) => (
              <Review key={review.id} {...review} />
            ))}
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
