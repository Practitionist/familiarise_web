import Image from "next/image";
import { User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import PricingToggle from "./PricingToggle";

import { PricingOption } from "../defaults";

// Utility function to map duration hours to labels
const getDurationLabel = (durationInHours: number): string => {
  return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
};

// Utility function to map subscription duration months to labels
const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
};

interface ConsultationPricingProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
  handleConsultationBooking: () => Promise<void>;
  handleSubscriptionBooking: (option: PricingOption) => Promise<void>;
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

export function ConsultationPricing({
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
}: Readonly<ConsultationPricingProps>) {
  const formatPricingOptions = (
    plans: (ConsultationPlan | SubscriptionPlan)[],
    type: "consultation" | "subscription",
  ): PricingOption[] => {
    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        const durationLabel = getDurationLabel(plan.durationInHours);

        // Define features based on consultation duration
        let features: string[] = [];
        switch (plan.durationInHours) {
          case 1: // Basic
            features = ["Document verification", "1 on 1 call"];
            break;
          case 2: // Extended
            features = [
              "Document verification",
              "1 on 1 call",
              "Extended chat facility",
            ];
            break;
          case 4: // Comprehensive
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
            `${plan.videoMeetings} video meeting${plan.videoMeetings > 1 ? "s" : ""}`,
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

  return (
    <div className="flex flex-col items-center w-full">
      <Image
        alt="Profile"
        className="rounded-full mb-6 border-2 border-gray-700/50 hidden lg:block"
        height="1350"
        src={userDetails.image || "/placeholder.svg"}
        style={{
          aspectRatio: "1080/1350",
          objectFit: "cover",
        }}
        width="1080"
      />
      <div className="card p-8 bg-gradient-to-br from-gray-900/90 to-gray-800/80 border border-gray-700/50 backdrop-blur-sm shadow-2xl rounded-2xl w-full">
        <div className="mb-6">
          <h3 className="text-2xl font-bold mb-2 text-white tracking-tight">Consultation Pricing</h3>
          <div className="h-1 w-16 bg-gradient-to-r from-white to-gray-600 rounded-full"></div>
        </div>
        <PricingToggle
          consultationOptions={consultationOptions}
          subscriptionOptions={subscriptionOptions}
          consultantDetails={consultantDetails}
          userDetails={userDetails}
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
          timezone={timezone}
        />
      </div>
    </div>
  );
}
