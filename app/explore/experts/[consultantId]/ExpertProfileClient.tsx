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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { differenceInCalendarDays } from "date-fns";
import { useSession } from "@/lib/auth-client";
import { AboutSection } from "./components/AboutSection";
import { ClassesAndWebinars } from "./components/ClassesAndWebinars";
import { DigitalProductsSection } from "./components/DigitalProductsSection";
import type { PublicProductCard } from "@/lib/data/digital-products-public";
import { ExperienceSection } from "./components/ExperienceSection";
import { ExpertPricing } from "./components/ExpertPricing";
import { ProfileHeader } from "./components/ProfileHeader";
import {
  ProfileAnchorTabs,
  PROFILE_SECTION_SCROLL_MARGIN,
} from "./components/ProfileAnchorTabs";
import { ReviewsSection } from "./components/ReviewsSection";
import { ProfileReviewComposer } from "@/components/reviews/ProfileReviewComposer";
import { useNowTick } from "@/hooks/use-now-tick";
import { calendarDateKey, calendarDayOf } from "@/lib/time/grid-zone";
import { useDisplayZone, type DisplayZone } from "@/lib/time/use-display-zone";
import {
  AVAILABILITY_READ_FAILED_MESSAGE,
  invalidateAvailability,
  useAvailabilityMonth,
  useAvailabilityWindow,
} from "@/lib/scheduling/use-availability-window";
import { dayState, isSelectableDay } from "./day-state";
import { useNextAvailableLabel } from "./use-next-available";
import { zonedWeekWindow } from "./utils/time";
import { cn } from "@/utils/tailwind";

interface ExpertProfileClientProps {
  consultantDetails: ConsultantDetailData;
  userDetails: TUserWithProfessionalBackground;
  reviews: TPublicConsultantReview[];
  reviewTracks: TReviewTrackPresence;
  digitalProducts: PublicProductCard[];
}

export function ExpertProfileClient({
  consultantDetails,
  userDetails,
  reviews,
  reviewTracks,
  digitalProducts,
}: ExpertProfileClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, isPending: isSessionPending } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pricingRef = useRef<HTMLDivElement>(null);
  const [autoOpenTrial, setAutoOpenTrial] = useState(false);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [selectedSlot, setSelectedSlot] = useState<TIntervalTiming | null>(
    null,
  );
  const [selectedDuration, setSelectedDuration] = useState<number>(() =>
    consultantDetails.consultationPlans.length > 0
      ? Math.min(
          ...consultantDetails.consultationPlans.map((p) => p.durationInHours),
        )
      : 1,
  );

  // Every time on the page is drawn in the VIEWER's profile zone, switchable
  // to the device zone. Reads wait for the session and the device zone so the
  // first request is already in the right zone.
  const zone = useDisplayZone(session?.user?.timezone ?? null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const zoneReady = mounted && !isSessionPending;
  const timezone = zone.zone;
  const now = useNowTick(60_000);
  const { toggle: toggleZone } = zone;
  const switchZone = useCallback(() => {
    toggleZone();
    setSelectedSlot(null);
  }, [toggleZone]);
  const displayZone = useMemo<DisplayZone>(
    () => ({
      zone: zone.zone,
      usingDeviceZone: zone.usingDeviceZone,
      canSwitch: zone.canSwitch,
      toggle: switchZone,
    }),
    [zone.zone, zone.usingDeviceZone, zone.canSwitch, switchZone],
  );

  const consulteeUserId =
    session?.user?.id && session.user.id !== consultantDetails.userId
      ? session.user.id
      : undefined;

  // #1591 J1-P1-04 — the grid answer is `private, max-age=30`, so a return
  // after a checkout 409 re-read the stale green cell. Entered with
  // `?conflict=1`, or restored from the back/forward cache, the next fetch
  // bypasses the browser cache once.
  const bypassCacheOnce = useRef(searchParams.get("conflict") === "1");

  // The week containing the selected day is read once per week window; day
  // clicks inside a loaded week cost zero requests (staleTime 30s).
  // Calendar dates (local fields) on both sides: today is today in the
  // display zone, and seven calendar days are a week across DST.
  const today = calendarDayOf(now, timezone);
  const selectedWeekOffset = selectedDate
    ? Math.max(0, Math.floor(differenceInCalendarDays(selectedDate, today) / 7))
    : 0;
  const pricingWeek = selectedDate
    ? zonedWeekWindow(now, selectedWeekOffset, timezone)
    : null;

  const dayQuery = useAvailabilityWindow({
    consultantId: consultantDetails?.id,
    startUtc: pricingWeek?.start ?? null,
    endUtc: pricingWeek?.end ?? null,
    timezone: zoneReady ? timezone : null,
    consulteeUserId,
    bypassRef: bypassCacheOnce,
  });

  // #1785 L-4 — one read for the visible month drives the day marks. It is
  // keyed on the month, so paging the calendar costs one request per month
  // and re-opening the dialog on a loaded month costs none.
  const monthQuery = useAvailabilityMonth({
    consultantId: consultantDetails?.id,
    monthStart: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1),
    timezone: zoneReady ? timezone : null,
    consulteeUserId,
  });

  const nextAvailableLabel = useNextAvailableLabel({
    consultantId: consultantDetails?.id,
    today,
    now,
    timezone,
    zoneReady,
    consulteeUserId,
    durationInHours: selectedDuration,
  });

  const selectedDateKey =
    selectedDate && zoneReady ? calendarDateKey(selectedDate) : null;
  const slotTimings: TIntervalTiming[] =
    (selectedDateKey && dayQuery.data?.[selectedDateKey]) || [];

  // A failed background poll keeps the last good answer on screen, so only a
  // read with nothing to show is worth a toast. The server's own text stays
  // in the console (useAvailabilityWindow logs it).
  const dayQueryHasData = dayQuery.data !== undefined;
  useEffect(() => {
    if (dayQuery.error && !dayQueryHasData) {
      toast({
        title: "Couldn't load the available times",
        description: AVAILABILITY_READ_FAILED_MESSAGE,
        variant: "destructive",
      });
    }
  }, [dayQuery.error, dayQueryHasData, toast]);

  const refreshSlots = useCallback(
    () => invalidateAvailability(queryClient, consultantDetails?.id),
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
        toast({ title: "Pick a time first", variant: "destructive" });
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
      if (selectedSlot.type === "WEEKLY") {
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
  // come from the month read; while it loads the cells pulse, and if it
  // fails the cells stay plain and clickable under a one-line notice.
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
    const marks = monthQuery.data ?? null;
    const marksLoading = monthQuery.isPending && zoneReady;
    const selectedKey = selectedDate ? calendarDateKey(selectedDate) : null;

    for (let i = 0; i < adjustedFirstDay; i++) {
      days.push(
        <div key={`empty-${i}`} className="aspect-square w-full"></div>,
      );
    }

    for (let i = 1; i <= daysInMonth; i++) {
      // A calendar date: only its local fields are read, and the grid keys
      // its days `yyyy-MM-dd` in the display zone.
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
        12,
      );
      const key = calendarDateKey(date);
      const isSelected = selectedKey === key;
      const state = dayState(
        date,
        now,
        marks ? (marks[key] ?? []) : null,
        timezone,
        selectedDuration,
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
            // A fluid square, capped at the old 44px: seven fixed 40–44px cells
            // do not fit a phone-width dialog, so they overflowed it.
            "relative mx-auto flex aspect-square w-full max-w-[2.75rem] items-center justify-center rounded-full text-sm transition-all duration-200 sm:text-base",
            isSelected && "bg-white font-medium text-zinc-900 shadow-md",
            !isSelected &&
              bookable &&
              "ring-1 ring-white/40 font-semibold text-zinc-100 hover:bg-zinc-700/60",
            !isSelected &&
              (state === "unknown" || state === "today+unknown") &&
              "font-medium text-zinc-300 hover:bg-zinc-700/60",
            !isSelected &&
              (state === "none" || state === "today+none") &&
              "text-zinc-500",
            state === "past" && "opacity-40 text-zinc-500",
            marksLoading &&
              state !== "past" &&
              !isSelected &&
              "animate-pulse ring-1 ring-white/10",
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

    if (monthQuery.isError) {
      days.push(
        <p
          key="marks-error"
          role="status"
          className="col-span-7 pt-2 text-center text-xs text-zinc-500"
        >
          Couldn&apos;t load availability marks — pick a day to see its times.
        </p>,
      );
    }

    return days;
  }, [
    currentDate,
    selectedDate,
    timezone,
    now,
    zoneReady,
    selectedDuration,
    monthQuery.data,
    monthQuery.isPending,
    monthQuery.isError,
  ]);

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

      <ProfileAnchorTabs
        present={{
          about: true,
          sessions:
            consultantDetails.consultationPlans.length > 0 ||
            consultantDetails.subscriptionPlans.length > 0,
          programs:
            consultantDetails.classPlans.length > 0 ||
            consultantDetails.webinarPlans.length > 0,
          products: digitalProducts.length > 0,
          reviews: consultantDetails._count.reviews > 0,
        }}
      />

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

              <div id="about" className={PROFILE_SECTION_SCROLL_MARGIN}>
                <AboutSection
                  userDetails={userDetails}
                  consultantDetails={consultantDetails}
                />
              </div>

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
            id="sessions"
            className={cn(
              PROFILE_SECTION_SCROLL_MARGIN,
              "w-full xl:w-[450px] 2xl:w-[500px] flex-shrink-0",
            )}
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
              slotsReady={dayQueryHasData && selectedDateKey !== null}
              selectedSlot={selectedSlot}
              setSelectedSlot={setSelectedSlot}
              displayZone={displayZone}
              autoOpenTrial={autoOpenTrial}
              onRefreshSlots={refreshSlots}
              onDurationChange={setSelectedDuration}
              nextAvailableLabel={nextAvailableLabel}
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
            <div className="space-y-8">
              {(consultantDetails.classPlans.length > 0 ||
                consultantDetails.webinarPlans.length > 0) && (
                <div id="programs" className={PROFILE_SECTION_SCROLL_MARGIN}>
                  <ClassesAndWebinars
                    classPlans={consultantDetails.classPlans}
                    webinarPlans={consultantDetails.webinarPlans}
                  />
                </div>
              )}
              {digitalProducts.length > 0 && (
                <div id="products" className={PROFILE_SECTION_SCROLL_MARGIN}>
                  <DigitalProductsSection products={digitalProducts} />
                </div>
              )}
            </div>
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
