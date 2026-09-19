"use client";

import { useToast } from "@/components/ui/use-toast";
import type { ConsultantDetailData } from "./types";
import { TIntervalTiming } from "@/types/slots";
import { TUserWithProfessionalBackground } from "@/types/user";
import type {
  TPublicConsultantReview,
  TReviewTrackPresence,
} from "@/types/review";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { addDays, endOfDay, startOfDay } from "date-fns";
import { useSession } from "@/lib/auth-client";
import { AboutSection } from "./components/AboutSection";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { ConsultantAvailability } from "./components/ConsultantAvailability";
import { ExperienceSection } from "./components/ExperienceSection";
import { ExpertPricing } from "./components/ExpertPricing";
import { ProfileHeader } from "./components/ProfileHeader";
import { ReviewsSection } from "./components/ReviewsSection";
import { ProfileReviewComposer } from "@/components/reviews/ProfileReviewComposer";
import { useTimezone } from "./hooks/useTimezone";
import { useAvailabilityWindow } from "./hooks/useAvailabilityWindow";
import { formatInTimeZone } from "date-fns-tz";

interface ExpertProfileClientProps {
  consultantDetails: ConsultantDetailData;
  userDetails: TUserWithProfessionalBackground;
  reviews: TPublicConsultantReview[];
  reviewTracks: TReviewTrackPresence;
}

export function ExpertProfileClient({
  consultantDetails,
  userDetails,
  reviews,
  reviewTracks,
}: ExpertProfileClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { timezone: browserTimezone, isLoading: isTimezoneLoading } =
    useTimezone();
  const { toast } = useToast();
  const pricingRef = useRef<HTMLDivElement>(null);
  const [autoOpenTrial, setAutoOpenTrial] = useState(false);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [selectedSlot, setSelectedSlot] = useState<TIntervalTiming | null>(
    null,
  );

  const timezone = browserTimezone || userDetails?.timezone;

  // #1591 J1-P1-04 — the grid answer is `private, max-age=30`, so a return
  // after a checkout 409 re-read the stale green cell. Entered with
  // `?conflict=1`, or restored from the back/forward cache, the next fetch
  // bypasses the browser cache once.
  const bypassCacheOnce = useRef(searchParams.get("conflict") === "1");

  // Pricing-day slots share the overview's week-window query: the week
  // containing the selected day uses the same [start, end] computation as
  // ConsultantAvailability's weekOffset, so an overlapping reader joins the
  // single in-flight request instead of firing its own 1-day compute. Day
  // clicks inside a loaded week cost zero requests (staleTime 30s).
  const todayStart = startOfDay(new Date());
  const selectedWeekOffset = selectedDate
    ? Math.max(
        0,
        Math.floor(
          (startOfDay(selectedDate).getTime() - todayStart.getTime()) /
            (7 * 24 * 60 * 60 * 1000),
        ),
      )
    : 0;
  const pricingWeekStart = addDays(todayStart, selectedWeekOffset * 7);
  const pricingWeekEnd = endOfDay(addDays(pricingWeekStart, 6));

  const dayQuery = useAvailabilityWindow({
    consultantId: consultantDetails?.id,
    startUtc: selectedDate ? pricingWeekStart : null,
    endUtc: selectedDate ? pricingWeekEnd : null,
    timezone: !isTimezoneLoading ? (timezone ?? null) : null,
    bypassRef: bypassCacheOnce,
  });

  const selectedDateKey =
    selectedDate && timezone && !isTimezoneLoading
      ? formatInTimeZone(selectedDate, timezone, "yyyy-MM-dd")
      : null;
  const slotTimings: TIntervalTiming[] =
    (selectedDateKey && dayQuery.data?.[selectedDateKey]) || [];

  useEffect(() => {
    if (dayQuery.error) {
      toast({
        title: "Error fetching slots",
        description: dayQuery.error.message || "Please try again",
        variant: "destructive",
      });
    }
  }, [dayQuery.error, toast]);

  const refreshSlots = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ["availability", consultantDetails?.id],
      }),
    [queryClient, consultantDetails?.id],
  );

  // Handle ?action=trial or ?action=book from explore page buttons
  useEffect(() => {
    const action = searchParams.get("action");
    if (!action) return;

    // Small delay to let the page render before scrolling
    const timer = setTimeout(() => {
      pricingRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      if (action === "trial") {
        setAutoOpenTrial(true);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchParams]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      bypassCacheOnce.current = true;
      void refreshSlots();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [refreshSlots]);

  const handleConsultationBooking = useCallback(
    async (consultationPlanId: string) => {
      if (!selectedSlot || !consultantDetails) {
        toast({ title: "Please select a slot", variant: "destructive" });
        return;
      }

      const activePlan = consultantDetails.consultationPlans.find(
        (plan) => plan.id === consultationPlanId,
      );

      if (!activePlan) {
        toast({ title: "Consultation unavailable", variant: "destructive" });
        return;
      }

      const params = new URLSearchParams();
      const startsAt = new Date(selectedSlot.startsAt);
      const endsAt = new Date(selectedSlot.endsAt);
      if (
        (selectedSlot as TIntervalTiming & { type: "WEEKLY" | "CUSTOM" })
          .type === "WEEKLY"
      ) {
        params.append(
          "availabilityWindowWeeklyId",
          selectedSlot.availabilityWindowId,
        );
      } else {
        params.append(
          "availabilityWindowCustomId",
          selectedSlot.availabilityWindowId,
        );
      }
      params.append("startsAt", startsAt.toISOString());
      params.append("endsAt", endsAt.toISOString());

      const checkoutUrl = `/checkout/plans/consultation/${activePlan.id}?${params.toString()}`;
      // #booking-journey — route guests through sign-in EXPLICITLY, carrying
      // the full checkout URL (plan + slot params) as the callback. Letting
      // them hit /checkout first works only via a middleware 302 onto a
      // generic sign-in page with no purchase context; doing it here keeps
      // one full-page load out of the funnel and reads as intentional.
      // SPA navigation (router.push) so the client bundle stays warm.
      if (!session?.user?.id) {
        router.push(
          `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`,
        );
        return;
      }
      router.push(checkoutUrl);
    },
    [selectedSlot, consultantDetails, session?.user?.id, router, toast],
  );

  const handleSubscriptionBooking = useCallback(
    async (
      option: {
        id: string;
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

      // Resolve by id so plans with duplicate durations still route to the
      // exact one the user selected in the tab.
      const activePlan = consultantDetails.subscriptionPlans.find(
        (plan) => plan.id === option.id,
      );

      if (!activePlan) {
        toast({ title: "Subscription unavailable", variant: "destructive" });
        return;
      }

      const schedulingPeriodStartsAt = schedulingPeriod.startDate.toISOString();
      const schedulingPeriodEndsAt = schedulingPeriod.endDate.toISOString();

      const params = new URLSearchParams({
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
      });
      const checkoutUrl = `/checkout/plans/subscription/${activePlan.id}?${params.toString()}`;
      // #booking-journey — same explicit guest handoff as consultations: the
      // checkout URL (plan + scheduling period) becomes the auth callback so
      // the purchase resumes untouched after sign-in/sign-up/onboarding.
      // SPA navigation (router.push) so the client bundle stays warm.
      if (!session?.user?.id) {
        router.push(
          `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`,
        );
        return;
      }
      router.push(checkoutUrl);
    },
    [consultantDetails, session?.user?.id, router, toast],
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

  return (
    <main className="bg-muted">
      {/* Back Navigation */}
      <div className="bg-card border-b border-border">
        <div className="w-full px-4 md:px-8 lg:px-12 py-4">
          <Link
            href="/explore/experts"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
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
                reviewCount={consultantDetails._count.reviews}
              />

              <AboutSection
                userDetails={userDetails}
                consultantDetails={consultantDetails}
              />

              <ExperienceSection
                workExperiences={userDetails.workExperiences || []}
                education={userDetails.education || []}
                certifications={userDetails.certifications || []}
              />

              {/* Gated on timezone resolution: the overview used to fire
                  immediately with the "UTC" fallback and then refire with the
                  real zone — a third, wrong-zone allocation compute per visit.
                  One effect-tick delay is invisible inside the page fade-in. */}
              {!isTimezoneLoading && timezone ? (
                <ConsultantAvailability
                  consultantDetails={consultantDetails}
                  timezone={timezone}
                />
              ) : null}
            </div>
          </motion.div>

          {/* Sidebar - Pricing */}
          <motion.div
            ref={pricingRef}
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
              autoOpenTrial={autoOpenTrial}
              onRefreshSlots={refreshSlots}
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
            <ReviewsSection
              reviews={reviews}
              reviewTracks={reviewTracks}
              reviewCount={consultantDetails._count.reviews}
              publishedRatingOneToOne={
                consultantDetails.publishedRatingOneToOne
              }
              publishedRatingGroup={consultantDetails.publishedRatingGroup}
              ratedClientsOneToOne={consultantDetails.ratedClientsOneToOne}
              ratedEventsGroup={consultantDetails.ratedEventsGroup}
              // #1300 — a review is about the CONSULTANT, so it is written on
              // their profile. It was only ever writable from the appointment
              // detail page, which contradicted the model. A client island
              // because eligibility is a per-user answer and this page is
              // statically cached — rendering it server-side would either force
              // the page dynamic or land one viewer's eligibility in a shared
              // cache entry.
              composer={
                <ProfileReviewComposer
                  consultantProfileId={consultantDetails.id}
                  consultantName={consultantDetails.user?.name ?? null}
                />
              }
            />
          </motion.div>
          {/* Spacer to match pricing sidebar width */}
          <div className="hidden xl:block w-[450px] 2xl:w-[500px] flex-shrink-0" />
        </div>
      </div>
    </main>
  );
}
