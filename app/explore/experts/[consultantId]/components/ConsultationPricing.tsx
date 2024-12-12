import Image from "next/image";
import { User, ConsultationPlan, SubscriptionPlan } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import PricingToggle from "./PricingToggle";

interface PricingOption {
  title: string;
  description: string;
  price: number;
  duration: string;
  features?: string[];
}

interface ConsultationPricingProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
  handleBooking: () => Promise<void>;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: () => JSX.Element[];
  slotTimings: TSlotTiming[];
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
}

export function ConsultationPricing({
  userDetails,
  consultantDetails,
  handleBooking,
  selectedDate,
  setSelectedDate,
  currentDate,
  setCurrentDate,
  renderCalendar,
  slotTimings,
  selectedSlot,
  setSelectedSlot,
}: ConsultationPricingProps) {
  const formatPricingOptions = (
    plans: (ConsultationPlan | SubscriptionPlan)[],
    type: "consultation" | "subscription",
  ): PricingOption[] => {
    return plans.map((plan) => {
      if (type === "consultation" && "durationInHours" in plan) {
        return {
          title: `${plan.durationInHours} Hour${plan.durationInHours > 1 ? "s" : ""}`,
          description: `${plan.durationInHours} hour consultation`,
          price: plan.price,
          duration: `${plan.durationInHours} hour${plan.durationInHours > 1 ? "s" : ""}`,
        };
      } else if (type === "subscription" && "durationInMonths" in plan) {
        return {
          title: `${plan.durationInMonths} Month${plan.durationInMonths > 1 ? "s" : ""}`,
          description: `${plan.durationInMonths} month subscription`,
          price: plan.price,
          duration: `${plan.durationInMonths} month${plan.durationInMonths > 1 ? "s" : ""}`,
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
    consultantDetails.consultationPlans,
    "consultation",
  );
  const subscriptionOptions = formatPricingOptions(
    consultantDetails.subscriptionPlans,
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
          handleBooking={handleBooking}
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          currentDate={currentDate}
          setCurrentDate={setCurrentDate}
          renderCalendar={renderCalendar}
          slotTimings={slotTimings}
          selectedSlot={selectedSlot}
          setSelectedSlot={setSelectedSlot}
        />
      </div>
    </div>
  );
}
