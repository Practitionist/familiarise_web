"use client";

import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";
import { TIntervalTiming } from "@/types/slots";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ConsultationPricingToggle from "./ConsultationPricingToggle";
import SubscriptionPricingToggle from "./SubscriptionPricingToggle";
import {
  Shield,
  Calendar,
  MessageSquare,
  RotateCcw,
  CheckCircle,
} from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";

import { PricingOption } from "../defaults";
import { bookingModeBadge } from "@/lib/booking/booking-mode";

const getDurationLabel = (durationInHours: number): string => {
  return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
};

const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
};

interface ExpertPricingProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
  handleConsultationBooking: (consultationPlanId: string) => Promise<void>;
  handleSubscriptionBooking: (
    option: PricingOption,
    schedulingPeriod: { startDate: Date; endDate: Date },
  ) => Promise<void>;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: () => JSX.Element[];
  slotTimings: TIntervalTiming[];
  selectedSlot: TIntervalTiming | null;
  setSelectedSlot: (slot: TIntervalTiming | null) => void;
  timezone: string;
  autoOpenTrial?: boolean;
  onRefreshSlots?: () => void;
  slotsLoading?: boolean;
  slotsError?: boolean;
  calendarLoading?: boolean;
  calendarError?: boolean;
  initialPlanId?: string | null;
  initialService?: "consultations" | "subscriptions";
  bookingRequest?: number;
}

export function ExpertPricing({
  userDetails: _userDetails,
  consultantDetails,
  handleConsultationBooking,
  handleSubscriptionBooking,
  selectedDate,
  setSelectedDate,
  currentDate,
  setCurrentDate,
  renderCalendar,
  slotTimings,
  selectedSlot,
  setSelectedSlot,
  timezone,
  autoOpenTrial,
  onRefreshSlots,
  slotsLoading,
  slotsError,
  calendarLoading,
  calendarError,
  initialPlanId,
  initialService,
  bookingRequest,
}: Readonly<ExpertPricingProps>) {
  const [activeServiceTab, setActiveServiceTab] = useState<
    "consultations" | "subscriptions"
  >(
    initialService ??
      (consultantDetails.consultationPlans.length
        ? "consultations"
        : "subscriptions"),
  );
  useEffect(() => {
    if (autoOpenTrial || initialService === "subscriptions")
      setActiveServiceTab("subscriptions");
    else if (initialService === "consultations")
      setActiveServiceTab("consultations");
  }, [autoOpenTrial, initialService]);

  const formatPricingOptions = (
    // Rows from the detail fetcher, not raw Prisma types — keeps price: number (#780)
    plans: (
      | ConsultantDetailData["consultationPlans"][number]
      | ConsultantDetailData["subscriptionPlans"][number]
    )[],
    type: "consultation" | "subscription",
  ): PricingOption[] => {
    // Count plans per duration so we can disambiguate titles when multiple
    // plans share the same duration (e.g. two 1-hour consultations).
    const durationCounts = new Map<number, number>();
    for (const plan of plans) {
      const key =
        type === "consultation" && "durationInHours" in plan
          ? plan.durationInHours
          : type === "subscription" && "durationInMonths" in plan
            ? plan.durationInMonths
            : undefined;
      if (key !== undefined) {
        durationCounts.set(key, (durationCounts.get(key) || 0) + 1);
      }
    }
    const seen = new Map<number, number>();
    const disambiguate = (label: string, duration: number): string => {
      if ((durationCounts.get(duration) || 0) <= 1) return label;
      const next = (seen.get(duration) || 0) + 1;
      seen.set(duration, next);
      return `${label} (${next})`;
    };

    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        const durationLabel = disambiguate(
          getDurationLabel(plan.durationInHours),
          plan.durationInHours,
        );

        // The consultant's own inclusions win. The duration switch below is a
        // placeholder from before `whatsIncluded` existed: it asserted
        // "Document verification" and "Priority support" for every plan of a
        // given length, whether or not that consultant offered either.
        let features: string[] = plan.whatsIncluded ?? [];
        if (features.length === 0) {
          switch (plan.durationInHours) {
            case 1:
              features = ["Document verification", "1 on 1 call"];
              break;
            case 2:
              features = [
                "Document verification",
                "1 on 1 call",
                "Extended chat facility",
              ];
              break;
            case 4:
              features = [
                "Document verification",
                "1 on 1 call",
                "Extended chat facility",
                "Priority support",
              ];
              break;
            default:
              features = [`${plan.durationInHours} hour consultation`];
          }
        }

        return {
          id: plan.id,
          title: durationLabel,
          // Surface the real plan title so duplicate-duration plans
          // (e.g. "Career Strategy Session" vs "[ATEST] Career Strategy
          // Session") stay distinguishable in the panel.
          description:
            plan.subtitle ||
            plan.title ||
            `${plan.durationInHours} hour consultation`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
          durationInHours: plan.durationInHours,
          features: features,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        const durationLabel = disambiguate(
          getSubscriptionDurationLabel(plan.durationInMonths),
          plan.durationInMonths,
        );
        return {
          id: plan.id,
          title: durationLabel,
          description:
            plan.title || `${plan.durationInMonths} month subscription`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInMonths}`,
          durationInMonths: plan.durationInMonths,
          totalHours: plan.totalHours,
          totalSessions: plan.totalSessions,
          sessionsPerWeek: plan.sessionsPerWeek,
          sessionDurationInHours: plan.sessionDurationInHours,
          features: [
            `${plan.totalHours} total hours`,
            `${plan.totalSessions} sessions`,
            `${plan.sessionsPerWeek} session${plan.sessionsPerWeek > 1 ? "s" : ""} per week`,
            `${plan.sessionDurationInHours}h per session`,
            `${plan.emailSupport} email support`,
          ],
        };
      }
      // Both branches above cover every (type, plan-shape) combination
      // we ever pass in. Throw rather than returning a dummy `id: ""`
      // option — that empty id used to risk colliding with real plan ids
      // as a tab key, even though the branch is unreachable in practice.
      throw new Error(
        `formatPricingOptions: unreachable plan shape (type=${type}, plan id=${"id" in plan ? plan.id : "?"})`,
      );
    });
  };

  const consultationOptions = formatPricingOptions(
    [...consultantDetails.consultationPlans].sort(
      (a, b) => a.durationInHours - b.durationInHours,
    ),
    "consultation",
  );
  const subscriptionOptions = formatPricingOptions(
    [...consultantDetails.subscriptionPlans].sort(
      (a, b) => a.durationInMonths - b.durationInMonths,
    ),
    "subscription",
  );

  const hasConsultations = consultationOptions.length > 0;
  const hasSubscriptions = subscriptionOptions.length > 0;

  return (
    <div className="xl:sticky xl:top-[calc(var(--header-height,5rem)+var(--maintenance-banner-height,0px)+1.5rem)] space-y-4">
      {/* Light, focused booking panel */}
      <div className="explore-booking-panel">
        {/* Header */}
        <div className="text-center mb-5">
          <h3 className="text-xl font-bold text-foreground mb-1">
            Book a Session
          </h3>
          <p className="text-xs text-muted-foreground tracking-wide uppercase font-medium">
            Choose your preferred option
          </p>
          {/* #1703 D1 — metadata only: how this expert takes bookings.
              #1775 C-6 — consultations only; a plan is always paid at purchase. */}
          {hasConsultations &&
            (!hasSubscriptions || activeServiceTab === "consultations") && (
              <span className="mt-3 inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {bookingModeBadge(
                  consultantDetails.bookingMode,
                  consultantDetails.acceptingRequests,
                )}
              </span>
            )}
        </div>

        {hasConsultations && hasSubscriptions ? (
          <Tabs
            value={activeServiceTab}
            onValueChange={(v) =>
              setActiveServiceTab(v as "consultations" | "subscriptions")
            }
            className="w-full"
          >
            {/* Segmented pill toggle for service type */}
            <TabsList className="pricing-segments mb-6">
              {(["consultations", "subscriptions"] as const).map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl flex items-center justify-center gap-2 data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-muted-foreground transition-colors duration-300 z-10 h-auto"
                >
                  {activeServiceTab === tab && (
                    <motion.div
                      layoutId="service-type-pill"
                      className="absolute inset-0 bg-card rounded-xl shadow-sm"
                      transition={{
                        type: "spring",
                        bounce: 0.15,
                        duration: 0.35,
                      }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-2">
                    {tab === "consultations" ? (
                      <Calendar className="w-3.5 h-3.5" />
                    ) : (
                      <MessageSquare className="w-3.5 h-3.5" />
                    )}
                    {tab === "consultations" ? "One-time" : "Mentorship"}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="consultations">
              <ConsultationPricingToggle
                consultationOptions={consultationOptions}
                consultantDetails={consultantDetails}
                handleConsultationBooking={handleConsultationBooking}
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                currentDate={currentDate}
                setCurrentDate={setCurrentDate}
                renderCalendar={renderCalendar}
                slotTimings={slotTimings}
                selectedSlot={selectedSlot}
                setSelectedSlot={setSelectedSlot}
                timezone={timezone}
                onRefreshSlots={onRefreshSlots}
                slotsLoading={slotsLoading}
                slotsError={slotsError}
                calendarLoading={calendarLoading}
                calendarError={calendarError}
                initialPlanId={initialPlanId}
                bookingRequest={bookingRequest}
              />
            </TabsContent>
            <TabsContent value="subscriptions">
              <SubscriptionPricingToggle
                subscriptionOptions={subscriptionOptions}
                consultantDetails={consultantDetails}
                handleSubscriptionBooking={handleSubscriptionBooking}
                timezone={timezone}
                autoOpenTrial={autoOpenTrial}
                initialPlanId={initialPlanId}
                bookingRequest={bookingRequest}
              />
            </TabsContent>
          </Tabs>
        ) : hasConsultations ? (
          <ConsultationPricingToggle
            consultationOptions={consultationOptions}
            consultantDetails={consultantDetails}
            handleConsultationBooking={handleConsultationBooking}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            currentDate={currentDate}
            setCurrentDate={setCurrentDate}
            renderCalendar={renderCalendar}
            slotTimings={slotTimings}
            selectedSlot={selectedSlot}
            setSelectedSlot={setSelectedSlot}
            timezone={timezone}
            onRefreshSlots={onRefreshSlots}
            slotsLoading={slotsLoading}
            slotsError={slotsError}
            calendarLoading={calendarLoading}
            calendarError={calendarError}
            initialPlanId={initialPlanId}
            bookingRequest={bookingRequest}
          />
        ) : hasSubscriptions ? (
          <SubscriptionPricingToggle
            subscriptionOptions={subscriptionOptions}
            consultantDetails={consultantDetails}
            handleSubscriptionBooking={handleSubscriptionBooking}
            timezone={timezone}
            autoOpenTrial={autoOpenTrial}
            initialPlanId={initialPlanId}
            bookingRequest={bookingRequest}
          />
        ) : (
          <div className="text-center py-8">
            <p className="text-muted-foreground">No pricing plans available</p>
          </div>
        )}

        {/* Trust Badges — chip style */}
        <div className="mt-6 pt-5 border-t border-border">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border text-xs text-muted-foreground">
              <Shield className="w-3 h-3" />
              Secure
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border text-xs text-muted-foreground">
              <RotateCcw className="w-3 h-3" />
              Money-back
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border text-xs text-muted-foreground">
              <CheckCircle className="w-3 h-3" />
              Verified
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
