"use client";

import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { BookingCalendarLoadingGrid } from "@/components/booking/BookingCalendarLoadingGrid";
import type { BookingMode } from "@prisma/client";
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
import {
  addDays,
  differenceInCalendarDays,
  endOfDay,
  startOfDay,
} from "date-fns";
import { useSession } from "@/lib/auth-client";
import { AboutSection } from "./components/AboutSection";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { ExperienceSection } from "./components/ExperienceSection";
import { ExpertPricing } from "./components/ExpertPricing";
import { PlanDetailsSnapshot } from "./components/PlanDetailsSnapshot";
import { ProfileHeader } from "./components/ProfileHeader";
import { ReviewsSection } from "./components/ReviewsSection";
import { ProfileReviewComposer } from "@/components/reviews/ProfileReviewComposer";
import { useTimezone } from "@/hooks/useTimezone";
import {
  useAvailabilityMonth,
  useAvailabilityWindow,
} from "./hooks/useAvailabilityWindow";
import {
  durationDayMark,
  isSelectableDay,
  type DayBookingKind,
  type DayState,
} from "./day-state";
import { formatInTimeZone } from "date-fns-tz";
import { cn } from "@/utils/tailwind";

interface ExpertProfileClientProps {
  consultantDetails: ConsultantDetailData;
  userDetails: TUserWithProfessionalBackground;
  reviews: TPublicConsultantReview[];
  reviewTracks: TReviewTrackPresence;
}

function getDayAvailabilityLabel(kind: DayBookingKind): string {
  if (kind === "instant") return ", book-now times available";
  if (kind === "request") return ", times available by request";
  return "";
}

function getCalendarDayClassName(
  isSelected: boolean,
  kind: DayBookingKind,
  state: DayState,
  marksLoading: boolean,
): string {
  return cn(
    "relative flex aspect-square w-full max-w-11 items-center justify-center rounded-full text-sm transition-all duration-200 sm:text-base",
    isSelected &&
      "bg-primary font-medium text-primary-foreground shadow-sm",
    isSelected && kind && "ring-2 ring-offset-2 ring-offset-background",
    isSelected && kind === "instant" && "ring-emerald-500",
    isSelected && kind === "request" && "ring-amber-500",
    !isSelected &&
      kind === "instant" &&
      "bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/50 hover:bg-emerald-500/20",
    !isSelected &&
      kind === "request" &&
      "bg-amber-500/10 font-semibold text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/50 hover:bg-amber-500/20",
    !isSelected &&
      (state === "unknown" || state === "today+unknown") &&
      "font-medium text-foreground hover:bg-muted",
    !isSelected &&
      (state === "none" || state === "today+none") &&
      "text-muted-foreground",
    state === "past" && "opacity-40 text-muted-foreground",
    marksLoading &&
      state !== "past" &&
      !isSelected &&
      "motion-safe:animate-pulse",
  );
}

function resolveInitialService(
  action: string | null,
): "subscriptions" | "consultations" | undefined {
  if (action === "subscribe" || action === "trial") return "subscriptions";
  if (action === "book") return "consultations";
  return undefined;
}

interface BuildCalendarCellsParams {
  currentDate: Date;
  selectedDate: Date | null;
  timezone: string | null | undefined;
  durationInHours: number;
  bookingMode: BookingMode;
  acceptingRequests: boolean;
  marks: Record<string, (TIntervalTiming & { isAllocated: boolean })[]> | null;
  marksLoading: boolean;
  marksError: boolean;
  onSelectDate: (date: Date) => void;
}

function buildCalendarCells({
  currentDate,
  selectedDate,
  timezone,
  durationInHours,
  bookingMode,
  acceptingRequests,
  marks,
  marksLoading,
  marksError,
  onSelectDate,
}: BuildCalendarCellsParams): JSX.Element[] {
  if (marksLoading && !marks) {
    return [
      <BookingCalendarLoadingGrid
        key="calendar-loading-grid"
        month={currentDate}
      />,
    ];
  }

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const adjustedFirstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const days: JSX.Element[] = [];
  const now = new Date();

  for (let i = 0; i < adjustedFirstDay; i++) {
    days.push(
      <div
        key={`empty-${year}-${month}-${i}`}
        className="aspect-square w-full max-w-11"
      />,
    );
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const isSelected =
      selectedDate?.getDate() === day &&
      selectedDate?.getMonth() === month &&
      selectedDate?.getFullYear() === year;
    const key = timezone
      ? formatInTimeZone(date, timezone, "yyyy-MM-dd")
      : null;
    const daySlots = marks && key ? (marks[key] ?? []) : null;
    const { state, kind } = durationDayMark(
      date,
      now,
      daySlots,
      durationInHours,
      timezone || "UTC",
      bookingMode,
      acceptingRequests,
    );
    const isToday = state.startsWith("today");
    const selectable = isSelectableDay(state);
    const availabilityLabel = getDayAvailabilityLabel(kind);

    days.push(
      <button
        key={`day-${year}-${month}-${day}`}
        type="button"
        disabled={!selectable}
        aria-pressed={isSelected}
        aria-label={`${date.toLocaleDateString(undefined, { day: "numeric", month: "long" })}${isToday ? ", today" : ""}${availabilityLabel}`}
        className={getCalendarDayClassName(
          isSelected,
          kind,
          state,
          marksLoading,
        )}
        onClick={() => onSelectDate(date)}
      >
        {day}
        {isToday && (
          <span
            aria-hidden="true"
            className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current"
          />
        )}
      </button>,
    );
  }

  if (marksError) {
    days.push(
      <p
        key="marks-error"
        role="status"
        className="col-span-7 pt-2 text-center text-xs text-muted-foreground"
      >
        Couldn&apos;t load availability marks — pick a day to see its times.
      </p>,
    );
  }

  return days;
}

function buildConsultationCheckoutUrl(
  planId: string,
  slot: TIntervalTiming,
): string {
  const params = new URLSearchParams();
  const startsAt = new Date(slot.startsAt);
  const endsAt = new Date(slot.endsAt);
  const windowParam =
    slot.type === "WEEKLY"
      ? "availabilityWindowWeeklyId"
      : "availabilityWindowCustomId";
  params.append(windowParam, slot.availabilityWindowId);
  params.append("startsAt", startsAt.toISOString());
  params.append("endsAt", endsAt.toISOString());
  return `/checkout/plans/consultation/${planId}?${params.toString()}`;
}

export function ExpertProfileClient({
  consultantDetails,
  userDetails,
  reviews,
  reviewTracks,
}: Readonly<ExpertProfileClientProps>) {
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

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [selectedSlot, setSelectedSlot] = useState<TIntervalTiming | null>(
    null,
  );

  const timezone = browserTimezone || userDetails?.timezone;
  const bypassCacheOnce = useRef(searchParams.get("conflict") === "1");

  const todayStart = startOfDay(new Date());
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
  const resolvedTimezone = isTimezoneLoading ? null : (timezone ?? null);

  const dayQuery = useAvailabilityWindow({
    consultantId: consultantDetails?.id,
    startUtc: selectedDate ? pricingWeekStart : null,
    endUtc: selectedDate ? pricingWeekEnd : null,
    timezone: resolvedTimezone,
    bypassRef: bypassCacheOnce,
  });

  const monthQuery = useAvailabilityMonth({
    consultantId: consultantDetails?.id,
    monthStart: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1),
    timezone: resolvedTimezone,
  });

  const selectedDateKey =
    selectedDate && resolvedTimezone
      ? formatInTimeZone(selectedDate, resolvedTimezone, "yyyy-MM-dd")
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
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["availability", consultantDetails?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["availability-month", consultantDetails?.id],
        }),
      ]).then(() => undefined),
    [queryClient, consultantDetails?.id],
  );

  useEffect(() => {
    const action = searchParams.get("action");
    if (!action) return;

    const timer = setTimeout(() => {
      pricingRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      if (action === "trial") {
        setAutoOpenTrial(true);
      } else if (action === "book" || action === "subscribe") {
        setBookingRequest((n) => n + 1);
      }
    }, 350);
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

  const navigateToCheckout = useCallback(
    (checkoutUrl: string) => {
      if (!session?.user?.id) {
        router.push(
          `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`,
        );
        return;
      }
      router.push(checkoutUrl);
    },
    [session?.user?.id, router],
  );

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

      navigateToCheckout(
        buildConsultationCheckoutUrl(activePlan.id, selectedSlot),
      );
    },
    [selectedSlot, consultantDetails, navigateToCheckout, toast],
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

      const activePlan = consultantDetails.subscriptionPlans.find(
        (plan) => plan.id === option.id,
      );

      if (!activePlan) {
        toast({ title: "Subscription unavailable", variant: "destructive" });
        return;
      }

      const params = new URLSearchParams({
        schedulingPeriodStartsAt: schedulingPeriod.startDate.toISOString(),
        schedulingPeriodEndsAt: schedulingPeriod.endDate.toISOString(),
      });
      navigateToCheckout(
        `/checkout/plans/subscription/${activePlan.id}?${params.toString()}`,
      );
    },
    [consultantDetails, navigateToCheckout, toast],
  );

  const renderCalendar = useCallback(
    (durationInHours = 1) =>
      buildCalendarCells({
        currentDate,
        selectedDate,
        timezone,
        durationInHours,
        bookingMode: consultantDetails.bookingMode ?? "INSTANT",
        acceptingRequests: consultantDetails.acceptingRequests !== false,
        marks: monthQuery.data ?? null,
        marksLoading: monthQuery.isPending && !!timezone,
        marksError: monthQuery.isError,
        onSelectDate: (date) => {
          setSelectedDate(date);
          setSelectedSlot(null);
        },
      }),
    [
      currentDate,
      selectedDate,
      timezone,
      consultantDetails.bookingMode,
      consultantDetails.acceptingRequests,
      monthQuery.data,
      monthQuery.isPending,
      monthQuery.isError,
    ],
  );

  return (
    <main className="bg-muted pb-24 xl:pb-0">
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

      {/* Consolidated Two-Column Profile Layout */}
      <div className="w-full px-4 md:px-8 lg:px-12 py-8 md:py-12">
        <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
          {/* Left Column - All profile content sections */}
          <motion.div
            className="flex-1 min-w-0 space-y-8"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
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

            <PlanDetailsSnapshot
              consultationPlans={consultantDetails.consultationPlans ?? []}
              subscriptionPlans={consultantDetails.subscriptionPlans ?? []}
            />

            <ClassesAndWebinars
              classPlans={consultantDetails.classPlans}
              webinarPlans={consultantDetails.webinarPlans}
            />

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
              composer={
                <ProfileReviewComposer
                  consultantProfileId={consultantDetails.id}
                  consultantName={consultantDetails.user?.name ?? null}
                />
              }
            />
          </motion.div>

          {/* Right Column - Sticky Booking Panel */}
          <motion.div
            ref={pricingRef}
            id="expert-booking-panel"
            data-booking-panel
            className="w-full xl:w-[420px] 2xl:w-[460px] flex-shrink-0"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
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
              initialPlanId={searchParams.get("plan")}
              initialService={resolveInitialService(searchParams.get("action"))}
              slotsLoading={dayQuery.isFetching || isTimezoneLoading}
              slotsError={dayQuery.isError}
              onRefreshSlots={refreshSlots}
            />
          </motion.div>
        </div>
      </div>

      {/* Sticky Mobile Booking Bar */}
      <div className="xl:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur-md p-3">
        <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {userDetails.name || "Expert"}
            </p>
            <p className="text-xs text-muted-foreground">
              1:1 Consultations &amp; Mentorship
            </p>
          </div>
          <Button
            className="rounded-xl px-5 font-semibold"
            onClick={() => {
              pricingRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
          >
            Book a Session
          </Button>
        </div>
      </div>
    </main>
  );
}
