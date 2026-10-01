"use client";

import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";
import { TIntervalTiming } from "@/types/slots";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ConsultationPricingToggle from "./ConsultationPricingToggle";
import SubscriptionPricingToggle from "./SubscriptionPricingToggle";
import { Shield, Calendar, MessageSquare, CheckCircle } from "lucide-react";
import { motion } from "framer-motion";

import { PricingOption } from "../defaults";
import { bookingModeBadge } from "@/lib/booking/booking-mode";
import type { ExpertService } from "../offering-selection";

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
  selectedPlanId: string;
  selectedService: ExpertService;
  onServiceChange: (service: ExpertService) => void;
  onPlanChange: (id: string) => void;
  onCalendarOpenChange: (open: boolean) => void;
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
  selectedPlanId,
  selectedService: activeServiceTab,
  onServiceChange,
  onPlanChange,
  onCalendarOpenChange,
  bookingRequest,
}: Readonly<ExpertPricingProps>) {
  const formatPricingOptions = (
    // Rows from the detail fetcher, not raw Prisma types — keeps price: number (#780)
    plans: (
      | ConsultantDetailData["consultationPlans"][number]
      | ConsultantDetailData["subscriptionPlans"][number]
    )[],
    type: "consultation" | "subscription",
  ): PricingOption[] => {
    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        const features = plan.whatsIncluded.length
          ? plan.whatsIncluded
          : [`${plan.durationInHours} hour consultation`];

        return {
          id: plan.id,
          title: plan.title,
          description:
            plan.subtitle || `${plan.durationInHours} hour consultation`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
          durationInHours: plan.durationInHours,
          features: features,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        return {
          id: plan.id,
          title: plan.title,
          description:
            plan.subtitle || `${plan.durationInMonths} month mentorship`,
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
            ...(plan.emailSupport
              ? [`${plan.emailSupport.toLowerCase()} email support`]
              : []),
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
            {activeServiceTab === "subscriptions"
              ? "Choose your mentorship"
              : "Book a session"}
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
            onValueChange={(v) => onServiceChange(v as ExpertService)}
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
                selectedPlanId={selectedPlanId}
                onPlanChange={onPlanChange}
                onCalendarOpenChange={onCalendarOpenChange}
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
                selectedPlanId={selectedPlanId}
                onPlanChange={onPlanChange}
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
            selectedPlanId={selectedPlanId}
            onPlanChange={onPlanChange}
            onCalendarOpenChange={onCalendarOpenChange}
            bookingRequest={bookingRequest}
          />
        ) : hasSubscriptions ? (
          <SubscriptionPricingToggle
            subscriptionOptions={subscriptionOptions}
            consultantDetails={consultantDetails}
            handleSubscriptionBooking={handleSubscriptionBooking}
            timezone={timezone}
            autoOpenTrial={autoOpenTrial}
            selectedPlanId={selectedPlanId}
            onPlanChange={onPlanChange}
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
            {consultantDetails.isVerified && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border text-xs text-muted-foreground">
                <CheckCircle className="w-3 h-3" />
                Verified
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
