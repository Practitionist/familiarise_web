"use client";

import { useToast } from "@/components/ui/use-toast";
import type { ConsultantDetailData } from "./types";
import type { SingleTimeValue } from "@/components/scheduling/SingleTimePicker";
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
import { useSession } from "@/lib/auth-client";
import { consultationCheckoutHref } from "@/lib/booking/picked-time";
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
import { calendarDayOf } from "@/lib/time/grid-zone";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { invalidateAvailability } from "@/lib/scheduling/use-availability-window";
import { useNextAvailableLabel } from "./use-next-available";
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
  const displayZone = useDisplayZone(session?.user?.timezone ?? null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const zoneReady = mounted && !isSessionPending;
  const timezone = displayZone.zone;
  const now = useNowTick(60_000);

  const consulteeUserId =
    session?.user?.id && session.user.id !== consultantDetails.userId
      ? session.user.id
      : undefined;

  // The grid answer is `private, max-age=30`, so a return after a checkout
  // 409 would re-read the stale free time. Entered with `?conflict=1`, or
  // restored from the back/forward cache, the next read skips the cache once.
  const bypassCacheOnce = useRef(searchParams.get("conflict") === "1");

  const today = calendarDayOf(now, timezone);
  const nextAvailableLabel = useNextAvailableLabel({
    consultantId: consultantDetails?.id,
    today,
    now,
    timezone,
    zoneReady,
    consulteeUserId,
    durationInHours: selectedDuration,
  });

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
    (consultationPlanId: string, pick: SingleTimeValue) => {
      const activePlan = consultantDetails.consultationPlans.find(
        (plan) => plan.id === consultationPlanId,
      );
      if (!activePlan) {
        toast({ title: "Consultation unavailable", variant: "destructive" });
        return;
      }

      const checkoutUrl = consultationCheckoutHref(activePlan.id, pick);
      // Guests go through sign-in explicitly, carrying the full checkout URL
      // (plan and time) as the callback, so the purchase resumes untouched.
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
              displayZone={displayZone}
              consulteeUserId={consulteeUserId}
              bypassRef={bypassCacheOnce}
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
