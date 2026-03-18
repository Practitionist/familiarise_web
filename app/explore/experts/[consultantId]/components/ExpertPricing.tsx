"use client";

import Image from "next/image";
import { User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import type { TConsultantDetailData } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
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
import { useState } from "react";

import { PricingOption } from "../defaults";

const getDurationLabel = (durationInHours: number): string => {
  return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
};

const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
};

interface ExpertPricingProps {
  userDetails: User;
  consultantDetails: TConsultantDetailData;
  handleConsultationBooking: () => Promise<void>;
  handleSubscriptionBooking: (
    option: PricingOption,
    schedulingPeriod: { startDate: Date; endDate: Date },
  ) => Promise<void>;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: () => JSX.Element[];
  slotTimings: TSlotTiming[];
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
  timezone: string;
  autoOpenTrial?: boolean;
}

export function ExpertPricing({
  userDetails,
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
}: Readonly<ExpertPricingProps>) {
  const [activeServiceTab, setActiveServiceTab] = useState<
    "consultations" | "subscriptions"
  >(autoOpenTrial ? "subscriptions" : "consultations");

  const formatPricingOptions = (
    plans: (ConsultationPlan | SubscriptionPlan)[],
    type: "consultation" | "subscription",
  ): PricingOption[] => {
    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        const durationLabel = getDurationLabel(plan.durationInHours);

        let features: string[] = [];
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

        return {
          title: durationLabel,
          description: `${plan.durationInHours} hour consultation`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
          durationInHours: plan.durationInHours,
          features: features,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        const durationLabel = getSubscriptionDurationLabel(
          plan.durationInMonths,
        );
        return {
          title: durationLabel,
          description: `${plan.durationInMonths} month subscription`,
          price: plan.price,
          priceCurrency: plan.priceCurrency || "INR",
          duration: `${plan.durationInMonths}`,
          durationInMonths: plan.durationInMonths,
          totalHours: plan.totalHours,
          totalSessions: plan.totalSessions,
          callsPerWeek: plan.callsPerWeek,
          sessionDurationInHours: plan.sessionDurationInHours,
          features: [
            `${plan.totalHours} total hours`,
            `${plan.totalSessions} sessions`,
            `${plan.callsPerWeek} call${plan.callsPerWeek > 1 ? "s" : ""} per week`,
            `${plan.sessionDurationInHours}h per session`,
            `${plan.emailSupport} email support`,
          ],
        };
      }
      return {
        title: "",
        description: "",
        price: 0,
        priceCurrency: "INR",
        duration: "",
      };
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
    <div className="sticky top-24 space-y-4">
      {/* Profile Image Card — refined, no flat border */}
      <div className="rounded-3xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/10">
        <div className="aspect-[4/3] relative">
          <Image
            alt="Profile"
            className="object-cover"
            fill
            src={userDetails.image || "/placeholder.svg"}
            sizes="(max-width: 768px) 100vw, 400px"
          />
        </div>
      </div>

      {/* Pricing Card — glassmorphism dark */}
      <div className="bg-zinc-950/90 backdrop-blur-xl rounded-3xl p-6 shadow-2xl shadow-black/40 border border-white/[0.07] ring-1 ring-white/[0.04]">
        {/* Header */}
        <div className="text-center mb-5">
          <h3 className="text-xl font-bold text-white mb-1">Book a Session</h3>
          <p className="text-xs text-zinc-500 tracking-wide uppercase font-medium">
            Choose your preferred option
          </p>
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
            <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm mb-6 h-auto">
              {(["consultations", "subscriptions"] as const).map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl flex items-center justify-center gap-2 data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-zinc-400 transition-colors duration-300 z-10 h-auto"
                >
                  {activeServiceTab === tab && (
                    <motion.div
                      layoutId="service-type-pill"
                      className="absolute inset-0 bg-white rounded-xl shadow-sm"
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
          />
        ) : hasSubscriptions ? (
          <SubscriptionPricingToggle
            subscriptionOptions={subscriptionOptions}
            consultantDetails={consultantDetails}
            handleSubscriptionBooking={handleSubscriptionBooking}
            timezone={timezone}
          />
        ) : (
          <div className="text-center py-8">
            <p className="text-zinc-400">No pricing plans available</p>
          </div>
        )}

        {/* Trust Badges — chip style */}
        <div className="mt-6 pt-5 border-t border-white/[0.06]">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-500">
              <Shield className="w-3 h-3" />
              Secure
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-500">
              <RotateCcw className="w-3 h-3" />
              Money-back
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-500">
              <CheckCircle className="w-3 h-3" />
              Verified
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
