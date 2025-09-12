import Image from "next/image";
import { User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import PricingToggle from "./PricingToggle";

import { PricingOption } from "../defaults";

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
        // Map duration to tier name
        let planTierName = "";
        if (plan.durationInHours === 1) {
          planTierName = "Basic";
        } else if (plan.durationInHours === 2) {
          planTierName = "Extended";
        } else if (plan.durationInHours === 4) {
          planTierName = "Comprehensive";
        }

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

        const durationText = `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`;
        const title = durationText;
        const description = planTierName || durationText;

        return {
          title: title,
          description: description,
          price: plan.price,
          duration: durationText,
          features: features,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        // Map months to tier name
        let planTierName = "";
        if (plan.durationInMonths === 1) {
          planTierName = "Basic";
        } else if (plan.durationInMonths === 2) {
          planTierName = "Extended";
        } else if (plan.durationInMonths === 4) {
          planTierName = "Comprehensive";
        }

        const durationText = `${plan.durationInMonths} month${plan.durationInMonths > 1 ? "s" : ""}`;
        const title = durationText;
        const description = planTierName || durationText;

        return {
          title: title,
          description: description,
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

  const sortedConsultationPlans = [...consultantDetails.consultationPlans].sort(
    (a, b) => a.durationInHours - b.durationInHours,
  );
  const consultationOptions = formatPricingOptions(
    sortedConsultationPlans,
    "consultation",
  );
  const sortedSubscriptionPlans = [...consultantDetails.subscriptionPlans].sort(
    (a, b) => a.durationInMonths - b.durationInMonths,
  );
  const subscriptionOptions = formatPricingOptions(
    sortedSubscriptionPlans,
    "subscription",
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
