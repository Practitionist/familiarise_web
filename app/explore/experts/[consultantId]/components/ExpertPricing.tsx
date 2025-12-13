"use client";

import Image from "next/image";
import { User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ConsultationPricingToggle from "./ConsultationPricingToggle";
import SubscriptionPricingToggle from "./SubscriptionPricingToggle";
import { Shield, Calendar, MessageSquare } from "lucide-react";

import { PricingOption } from "../defaults";

const getDurationLabel = (durationInHours: number): string => {
  return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
};

const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
};

interface ExpertPricingProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
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
}: Readonly<ExpertPricingProps>) {
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
          duration: `${plan.durationInMonths}`,
          durationInMonths: plan.durationInMonths,
          features: [
            `${plan.callsPerWeek} call${plan.callsPerWeek > 1 ? "s" : ""} per week`,
            `${plan.sessionDurationInHours} hour session${plan.sessionDurationInHours > 1 ? "s" : ""}`,
            `${plan.emailSupport} email support`,
          ],
        };
      }
      return {
        title: "",
        description: "",
        price: 0,
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
    <div className="sticky top-24 space-y-6">
      {/* Profile Image Card */}
      <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
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

      {/* Pricing Card */}
      <div className="bg-zinc-950 rounded-2xl p-6 shadow-xl">
        {/* Header */}
        <div className="text-center mb-6">
          <h3 className="text-xl font-bold text-white mb-2">Book a Session</h3>
          <p className="text-sm text-zinc-400">Choose your preferred option</p>
        </div>

        {hasConsultations && hasSubscriptions ? (
          <Tabs defaultValue="consultations" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6 bg-zinc-900 p-1 rounded-xl">
              <TabsTrigger 
                value="consultations"
                className="rounded-lg data-[state=active]:bg-white data-[state=active]:text-zinc-900 text-zinc-400"
              >
                <Calendar className="w-4 h-4 mr-2" />
                One-time
              </TabsTrigger>
              <TabsTrigger 
                value="subscriptions"
                className="rounded-lg data-[state=active]:bg-white data-[state=active]:text-zinc-900 text-zinc-400"
              >
                <MessageSquare className="w-4 h-4 mr-2" />
                Mentorship
              </TabsTrigger>
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

        {/* Trust Badges */}
        <div className="mt-6 pt-6 border-t border-zinc-800">
          <div className="flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Shield className="w-4 h-4" />
            <span>Secure payments • Money-back guarantee</span>
          </div>
        </div>
      </div>
    </div>
  );
}
