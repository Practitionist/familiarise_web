import Image from "next/image";
import { User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import PricingToggle from "./PricingToggle";

import { PricingOption } from "../defaults";

// Utility function to map duration hours to labels
const getDurationLabel = (durationInHours: number): string => {
  switch (durationInHours) {
    case 1:
      return "Basic";
    case 2:
      return "Extended";
    case 4:
      return "Comprehensive";
    default:
      return `${durationInHours} Hour${durationInHours > 1 ? "s" : ""}`;
  }
};

// Utility function to map subscription duration months to labels
const getSubscriptionDurationLabel = (durationInMonths: number): string => {
  switch (durationInMonths) {
    case 1:
      return "Basic";
    case 3:
      return "Extended";
    case 6:
      return "Comprehensive";
    default:
      return `${durationInMonths} Month${durationInMonths > 1 ? "s" : ""}`;
  }
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
    type: "consultation" | "subscription"
  ): PricingOption[] => {
    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        const durationLabel = getDurationLabel(plan.durationInHours);
        return {
          title: durationLabel,
          description: `${plan.durationInHours} hour consultation`,
          price: plan.price,
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        const durationLabel = getSubscriptionDurationLabel(
          plan.durationInMonths
        );
        return {
          title: durationLabel,
          description: `${plan.durationInMonths} month subscription`,
          price: plan.price,
          duration: `${plan.durationInMonths}`,
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
      (a, b) => a.durationInHours - b.durationInHours
    ),
    "consultation"
  );
  const subscriptionOptions = formatPricingOptions(
    consultantDetails.subscriptionPlans.sort(
      (a, b) => a.durationInMonths - b.durationInMonths
    ),
    "subscription"
  );

  return (
    <div className="flex flex-col items-center w-1/4 ml-10">
      <Image
        alt="Profile"
        className="rounded-full mb-6"
        height="1350"
        src={userDetails.image || "/placeholder.svg"}
        style={{
          aspectRatio: "1080/1350",
          objectFit: "cover",
        }}
        width="1080"
      />
      <div className="card p-6 bg-white shadow-lg rounded-lg w-full">
        <h3 className="text-lg font-semibold mb-4">Consultation Pricing</h3>
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
