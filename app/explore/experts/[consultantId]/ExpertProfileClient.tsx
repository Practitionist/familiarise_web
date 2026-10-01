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
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  addDays,
  differenceInCalendarDays,
  endOfDay,
  startOfDay,
} from "date-fns";
import { useSession } from "@/lib/auth-client";
import { AboutSection } from "./components/AboutSection";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { OfferingPreview } from "./components/OfferingPreview";
import { resolveOffering, type ExpertService } from "./offering-selection";
import { ExperienceSection } from "./components/ExperienceSection";
import { ExpertPricing } from "./components/ExpertPricing";
import { ProfileHeader } from "./components/ProfileHeader";
import { ReviewsSection } from "./components/ReviewsSection";
import { ProfileReviewComposer } from "@/components/reviews/ProfileReviewComposer";
import { useTimezone } from "@/hooks/useTimezone";
import {
  useAvailabilityMonth,
  useAvailabilityWindow,
} from "./hooks/useAvailabilityWindow";
import { dayState, isSelectableDay } from "./day-state";
import { formatInTimeZone } from "date-fns-tz";
import { cn } from "@/utils/tailwind";

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
  const [bookingRequest, setBookingRequest] = useState(0);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const requestedPlan = searchParams.get("plan");
  const action = searchParams.get("action");
  const conflictReturn = searchParams.get("conflict") === "1";
  const requestedService =
    action === "subscribe" || action === "trial"
      ? "subscriptions"
      : action === "book"
        ? "consultations"
        : undefined;
  const [offering, setOffering] = useState(() =>
    resolveOffering(consultantDetails, requestedPlan, requestedService),
  );
  const selectedPlan =
    offering.service === "consultations"
      ? consultantDetails.consultationPlans.find(
          (plan) => plan.id === offering.planId,
        )
      : consultantDetails.subscriptionPlans.find(
          (plan) => plan.id === offering.planId,
        );

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
  const bypassCacheOnce = useRef(conflictReturn);
  const bypassMonthCacheOnce = useRef(conflictReturn);

  const changeOffering = useCallback(
    (planId: string | null, service?: ExpertService) => {
      setOffering(resolveOffering(consultantDetails, planId, service));
      setSelectedSlot(null);
      setAutoOpenTrial(false);
    },
    [consultantDetails],
  );

  useEffect(() => {
    changeOffering(requestedPlan, requestedService);
  }, [changeOffering, requestedPlan, requestedService]);

  // Read one week only while the consultation calendar is open. Choosing
  // another day in that week reuses the same cached availability answer.
  const todayStart = startOfDay(new Date());
  // Calendar-day arithmetic: a DST transition makes seven days 167 or 169
  // elapsed hours, which would park the selected day in the wrong week.
  const selectedWeekOffset = selectedDate
    ? Math.max(
        0,
        Math.floor(
          differenceInCalendarDays(startOfDay(selectedDate), todayStart) / 7,
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
    enabled: calendarOpen && offering.service === "consultations",
  });

  // #1785 L-4 — one read for the visible month drives the day marks. It is
  // keyed on the month, so paging the calendar costs one request per month
  // and re-opening the dialog on a loaded month costs none.
  const monthQuery = useAvailabilityMonth({
    consultantId: consultantDetails?.id,
    monthStart: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1),
    timezone: !isTimezoneLoading ? (timezone ?? null) : null,
    enabled: calendarOpen && offering.service === "consultations",
    bypassRef: bypassMonthCacheOnce,
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

  const refreshSlots = useCallback(() => {
    bypassCacheOnce.current = true;
    bypassMonthCacheOnce.current = true;
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["availability", consultantDetails?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["availability-month", consultantDetails?.id],
      }),
    ]).then(() => undefined);
  }, [queryClient, consultantDetails?.id]);

  useEffect(() => {
    if (!conflictReturn) return;
    setSelectedSlot(null);
    void refreshSlots();
  }, [conflictReturn, requestedPlan, refreshSlots]);

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
      if (action === "book" || action === "subscribe")
        setBookingRequest((n) => n + 1);
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

  // Day cells carry their state without colour (#1785 L-4): a ring and a bold
  // number on a day with a bookable time, plain grey and disabled on a day
  // without, dimmed and disabled in the past, a dot under today. The marks
  // come from the month read. The booking dialog replaces the date grid with
  // neutral placeholders until those marks are known. If the read fails,
  // unknown days remain plain and clickable to check their times individually.
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
    const now = new Date();
    const marks = monthQuery.data ?? null;

    for (let i = 0; i < adjustedFirstDay; i++) {
      days.push(<div key={`empty-${i}`} className="h-10 w-full"></div>);
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
      const key = timezone
        ? formatInTimeZone(date, timezone, "yyyy-MM-dd")
        : null;
      const state = dayState(
        date,
        now,
        marks && key ? (marks[key] ?? []) : null,
      );
      const isToday = state.startsWith("today");
      const selectable = isSelectableDay(state);
      const bookable = state === "bookable" || state === "today+bookable";

      days.push(
        <button
          key={i}
          type="button"
          disabled={!selectable}
          aria-pressed={isSelected}
          aria-label={`${date.toLocaleDateString(undefined, { day: "numeric", month: "long" })}${isToday ? ", today" : ""}${bookable ? ", times available" : ""}`}
          className={cn(
            "relative flex h-10 w-full items-center justify-center rounded-xl text-sm transition-colors duration-200",
            isSelected && "bg-primary font-semibold text-primary-foreground",
            !isSelected &&
              bookable &&
              "ring-1 ring-border font-semibold text-foreground hover:bg-accent",
            !isSelected &&
              (state === "unknown" || state === "today+unknown") &&
              "font-medium text-foreground hover:bg-accent",
            !isSelected &&
              (state === "none" || state === "today+none") &&
              "text-zinc-500",
            state === "past" && "opacity-40 text-zinc-500",
          )}
          onClick={() => {
            setSelectedDate(date);
            setSelectedSlot(null);
          }}
        >
          {i}
          {isToday && (
            <span
              aria-hidden="true"
              className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current"
            />
          )}
        </button>,
      );
    }

    return days;
  }, [currentDate, selectedDate, timezone, monthQuery.data]);

  return (
    <main className="explore-page pb-24 xl:pb-0">
      {/* Profile and selected offering; scheduling belongs in booking. */}
      <div className="explore-profile w-full px-4 md:px-8 lg:px-12 py-8 md:py-12">
        <nav aria-label="Breadcrumb" className="mb-6">
          <ol className="flex items-center gap-2 text-sm text-muted-foreground">
            <li>
              <Link
                href="/explore/experts"
                className="hover:text-foreground hover:underline"
              >
                Experts
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li aria-current="page" className="truncate">
              {userDetails.name || "Expert profile"}
            </li>
          </ol>
        </nav>
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

              <OfferingPreview
                consultantDetails={consultantDetails}
                service={offering.service}
                planId={offering.planId}
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
            </div>
          </motion.div>

          {/* Sidebar - Pricing */}
          <motion.div
            ref={pricingRef}
            data-booking-panel
            id="expert-booking"
            className="w-full xl:w-[450px] 2xl:w-[500px] flex-shrink-0"
            initial={false}
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
              bookingRequest={bookingRequest}
              selectedPlanId={offering.planId}
              selectedService={offering.service}
              onServiceChange={(service) => changeOffering(null, service)}
              onPlanChange={(id) => changeOffering(id, offering.service)}
              onCalendarOpenChange={setCalendarOpen}
              slotsLoading={dayQuery.isFetching || isTimezoneLoading}
              slotsError={dayQuery.isError}
              calendarLoading={monthQuery.isPending || isTimezoneLoading}
              calendarError={monthQuery.isError}
              onRefreshSlots={refreshSlots}
            />
          </motion.div>
        </div>
      </div>

      {selectedPlan && (
        <div className="mobile-booking-bar">
          <span className="min-w-0 truncate text-sm font-medium">
            {selectedPlan?.title || "Explore plans"}
          </span>
          <Button
            className="shrink-0 rounded-xl"
            onClick={() => setBookingRequest((n) => n + 1)}
          >
            {offering.service === "consultations"
              ? "Book a session"
              : "Start mentorship"}
          </Button>
        </div>
      )}

      {/* Classes & Webinars - Below main content only, not under pricing */}
      <div className="explore-profile w-full px-4 md:px-8 lg:px-12 pb-8">
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          <motion.div
            className="flex-1 min-w-0"
            initial={false}
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
      <div className="explore-profile w-full px-4 md:px-8 lg:px-12 pb-12">
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          <motion.div
            className="flex-1 min-w-0"
            initial={false}
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
