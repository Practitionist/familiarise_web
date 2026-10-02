"use client";

import type { User } from "@prisma/client";
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
import { motion, useReducedMotion } from "framer-motion";
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
  userDetails?: User;
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
  renderCalendar: (durationInHours: number) => JSX.Element[];
  slotTimings: TIntervalTiming[];
  selectedSlot: TIntervalTiming | null;
  setSelectedSlot: (slot: TIntervalTiming | null) => void;
  timezone: string;
  autoOpenTrial?: boolean;
  onRefreshSlots?: () => void;
  slotsLoading?: boolean;
  slotsError?: boolean;
  initialPlanId?: string | null;
  initialService?: "consultations" | "subscriptions";
  activeServiceTab?: "consultations" | "subscriptions";
  onServiceTabChange?: (tab: "consultations" | "subscriptions") => void;
  selectedConsultationPlanId?: string;
  onSelectConsultationPlanId?: (planId: string) => void;
  selectedSubscriptionPlanId?: string;
  onSelectSubscriptionPlanId?: (planId: string) => void;
  bookingRequest?: number;
}

export function ExpertPricing({
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
  initialPlanId,
  initialService,
  activeServiceTab: controlledServiceTab,
  onServiceTabChange,
  selectedConsultationPlanId,
  onSelectConsultationPlanId,
  selectedSubscriptionPlanId,
  onSelectSubscriptionPlanId,
  bookingRequest = 0,
}: Readonly<ExpertPricingProps>) {
  const reduceMotion = useReducedMotion();
  const [internalServiceTab, setInternalServiceTab] = useState<
    "consultations" | "subscriptions"
  >(
    initialService ??
      (autoOpenTrial ? "subscriptions" : "consultations"),
  );
  const activeServiceTab = controlledServiceTab ?? internalServiceTab;
  const handleServiceTabChange = (tab: "consultations" | "subscriptions") => {
    setInternalServiceTab(tab);
    onServiceTabChange?.(tab);
  };

  useEffect(() => {
    if (initialService) {
      setInternalServiceTab(initialService);
      onServiceTabChange?.(initialService);
    } else if (autoOpenTrial) {
      setInternalServiceTab("subscriptions");
      onServiceTabChange?.("subscriptions");
    }
  }, [initialService, autoOpenTrial, onServiceTabChange]);

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
    <div className="space-y-4 xl:sticky xl:top-[calc(var(--maintenance-banner-height,0px)+var(--header-height,5rem)+1.5rem)]">
      {/* Focused booking card using semantic tokens */}
      <div className="bg-card rounded-2xl border border-border p-6 shadow-elevation-1">
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
              handleServiceTabChange(v as "consultations" | "subscriptions")
            }
            className="w-full"
          >
            {/* Segmented pill toggle for service type */}
            <TabsList className="relative flex p-1 bg-muted rounded-2xl border border-border mb-6 h-auto">
              {(["consultations", "subscriptions"] as const).map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl flex items-center justify-center gap-2 data-[state=active]:text-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none text-muted-foreground transition-colors duration-300 z-10 h-auto"
                >
                  {activeServiceTab === tab && (
                    <motion.div
                      layoutId="service-type-pill"
                      className="absolute inset-0 bg-card rounded-xl shadow-sm border border-border/60"
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : {
                              type: "spring",
                              bounce: 0.15,
                              duration: 0.35,
                            }
                      }
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
                initialPlanId={initialPlanId}
                selectedPlanId={selectedConsultationPlanId}
                onSelectPlanId={onSelectConsultationPlanId}
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
                selectedPlanId={selectedSubscriptionPlanId}
                onSelectPlanId={onSelectSubscriptionPlanId}
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
            initialPlanId={initialPlanId}
            selectedPlanId={selectedConsultationPlanId}
            onSelectPlanId={onSelectConsultationPlanId}
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
            selectedPlanId={selectedSubscriptionPlanId}
            onSelectPlanId={onSelectSubscriptionPlanId}
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
