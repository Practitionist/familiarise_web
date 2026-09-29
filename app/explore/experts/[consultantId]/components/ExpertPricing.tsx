"use client";

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
import { useState } from "react";

import { PricingOption } from "../defaults";
import { bookingModeBadge } from "@/lib/booking/booking-mode";
import { EmptyState } from "@/components/ui/empty-state";
import { PricingPanel } from "@/components/explore/PricingPanel";

const getDurationLabel = (durationInHours: number): string => {
  return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
};

const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
};

interface ExpertPricingProps {
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
}: Readonly<ExpertPricingProps>) {
  const [activeServiceTab, setActiveServiceTab] = useState<
    "consultations" | "subscriptions"
  >(autoOpenTrial ? "subscriptions" : "consultations");

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
    consultantDetails.consultationPlans.sort(
      (a, b) => a.durationInHours - b.durationInHours,
    ),
    "consultation",
  );
  const subscriptionOptions = formatPricingOptions(
    consultantDetails.subscriptionPlans.sort(
      (a, b) => a.durationInMonths - b.durationInMonths,
    ),
    "subscription",
  );

  const hasConsultations = consultationOptions.length > 0;
  const hasSubscriptions = subscriptionOptions.length > 0;

  return (
    /* NOT sticky.

       Sticky helps when an element is shorter than the viewport and you want
       it to follow. This panel carries a calendar and a slot grid, so it runs
       ~1,800px in a ~750px viewport: `sticky top-24` pinned the top 750px and
       made the remaining ~1,050px — including the slot list and the booking
       button — unreachable except by scrolling the page past a pinned header.
       The grid now puts this in a real second column, so it is simply a column
       of content and scrolls with the biography. */
    <div className="space-y-4">
      {/* The booking panel. See components/explore/PricingPanel.tsx for why
          this is no longer a dark-glass island with a 24px radius. */}
      <PricingPanel title="Book a session" eyebrow="Choose your option">
        <div className="text-center">
          {/* #1703 D1 — metadata only: how this expert takes bookings.
              #1775 C-6 — consultations only; a plan is always paid at purchase. */}
          {hasConsultations &&
            (!hasSubscriptions || activeServiceTab === "consultations") && (
              <span className="mt-3 inline-flex items-center rounded-chip border border-brand-border bg-brand-subtle px-2 py-0.5 text-xs font-medium text-brand-foreground-subtle">
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
            {/* Service-type switch. This was the 3rd of the four hand-rolled
                segmented controls in the app, and the only one still needing
                a framer-motion `layoutId` — purely to slide a background pill.
                `data-[state=active]` does that in CSS, which also drops
                framer-motion out of this subtree.

                The trigger used `data-[state=active]:text-zinc-900` with a
                `bg-white` thumb, sized for a dark panel. On the light panel
                both had to invert. */}
            <TabsList className="mb-6 h-auto w-full gap-1 rounded-control border border-border bg-muted p-1">
              {(["consultations", "subscriptions"] as const).map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="flex h-9 flex-1 items-center justify-center gap-2 rounded-[0.3125rem] px-3 text-sm font-medium text-muted-foreground transition-colors data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-elevation-1 data-[state=active]:shadow-edge"
                >
                  {tab === "consultations" ? (
                    <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {tab === "consultations" ? "One-time" : "Mentorship"}
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
              />
            </TabsContent>
            <TabsContent value="subscriptions">
              <SubscriptionPricingToggle
                subscriptionOptions={subscriptionOptions}
                consultantDetails={consultantDetails}
                handleSubscriptionBooking={handleSubscriptionBooking}
                timezone={timezone}
                autoOpenTrial={autoOpenTrial}
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
          />
        ) : hasSubscriptions ? (
          <SubscriptionPricingToggle
            subscriptionOptions={subscriptionOptions}
            consultantDetails={consultantDetails}
            handleSubscriptionBooking={handleSubscriptionBooking}
            timezone={timezone}
          />
        ) : (
          <EmptyState
            size="inline"
            title="No pricing plans available"
            description="This expert hasn't published a bookable session yet."
          />
        )}

        {/* Trust Badges — chip style */}
        {/* Was `bg-white/[0.04] border-white/[0.06] text-zinc-500` — an
            alpha-white pill that only made sense over the old dark glass. */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 border-t border-border-subtle pt-5">
          <span className="inline-flex items-center gap-1.5 rounded-chip border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <Shield className="h-3 w-3" aria-hidden="true" />
            Secure
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-chip border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Money-back
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-chip border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <CheckCircle className="h-3 w-3" aria-hidden="true" />
            Verified
          </span>
        </div>
      </PricingPanel>
    </div>
  );
}
