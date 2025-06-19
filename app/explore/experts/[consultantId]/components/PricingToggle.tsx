"use client";

import { CalendarIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { ClockIcon } from "lucide-react";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import {
  PricingOption,
  defaultConsultationOptions,
  defaultSubscriptionOptions,
} from "../defaults";
import { TSlotTiming } from "@/types/slots";
import { breakDownSlotsByDuration } from "@/utils/timeSlotsProcessing";
import { useToast } from "@/hooks/use-toast";

interface PricingToggleProps {
  consultationOptions?: PricingOption[];
  subscriptionOptions?: PricingOption[];
  consultantDetails: any;
  userDetails: any;
  handleConsultationBooking: () => void;
  handleSubscriptionBooking: (option: PricingOption) => void;
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

export default function PricingToggle({
  consultationOptions = defaultConsultationOptions,
  subscriptionOptions = defaultSubscriptionOptions,
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
  consultantDetails,
}: Readonly<PricingToggleProps>) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("consultation");
  const [activeConsultationOption, setActiveConsultationOption] = useState(
    consultationOptions.length > 0
      ? consultationOptions[0].title.toLowerCase().replace(" ", "-")
      : defaultConsultationOptions[0].title.toLowerCase().replace(" ", "-"),
  );
  const [activeSubscriptionOption, setActiveSubscriptionOption] = useState(
    subscriptionOptions.length > 0
      ? subscriptionOptions[0].title.toLowerCase().replace(" ", "-")
      : defaultSubscriptionOptions[0].title.toLowerCase().replace(" ", "-"),
  );
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);

  // Get the duration of the selected consultation option
  const selectedDuration = useMemo(() => {
    const option = consultationOptions.find(
      (opt) =>
        opt.title.toLowerCase().replace(" ", "-") === activeConsultationOption,
    );
    return option ? parseInt(option.duration.split(" ")[0], 10) : 1;
  }, [activeConsultationOption, consultationOptions]);

  // Break down slots by selected duration using the utility function
  const availableSlots = useMemo(() => {
    if (
      !slotTimings ||
      slotTimings.length === 0 ||
      !timezone ||
      !selectedDate
    ) {
      return [];
    }

    // Convert to the format expected by breakDownSlotsByDuration
    const slotsWithAllocation = slotTimings.map((slot) => ({
      ...slot,
      isAllocated: slot.isAllocated || false,
    }));

    // Use the utility function to break down slots by duration
    const brokenDownSlots = breakDownSlotsByDuration(
      slotsWithAllocation,
      selectedDuration,
      [], // appointmentSlots - we'll rely on the isAllocated flag for now
      timezone,
    );

    // Return all slots (both available and allocated) - the UI will handle them differently
    return brokenDownSlots;
  }, [slotTimings, selectedDuration, timezone, selectedDate]);

  const handleRequestForApproval = async () => {
    if (!selectedSlot || !consultantDetails) {
      toast({ title: "Please select a time slot", variant: "destructive" });
      return;
    }

    if (!session?.user?.id) {
      toast({
        title: "Please sign in to request approval",
        variant: "destructive",
      });
      return;
    }

    // Calculate duration in hours from slot times
    const startTime = new Date(selectedSlot.slotStartTimeInUTC);
    const endTime = new Date(selectedSlot.slotEndTimeInUTC);
    const durationInHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    // Get the active consultation plan
    const activePlan = consultantDetails.consultationPlans.find(
      (plan: any) => plan.durationInHours === durationInHours,
    );

    if (!activePlan) {
      toast({ title: "Invalid consultation plan", variant: "destructive" });
      return;
    }

    setIsRequestingApproval(true);

    try {
      const requestBody: {
        consultantProfileId: string;
        slotStartTimeInUTC: string;
        slotEndTimeInUTC: string;
        consultationPlanId: string;
        slotOfAvailabilityWeeklyId?: string;
        slotOfAvailabilityCustomId?: string;
      } = {
        consultantProfileId: consultantDetails.id,
        slotStartTimeInUTC: selectedSlot.slotStartTimeInUTC,
        slotEndTimeInUTC: selectedSlot.slotEndTimeInUTC,
        consultationPlanId: activePlan.id,
      };

      // Add the appropriate availability slot ID based on slot type
      if ((selectedSlot as any).type === "WEEKLY") {
        requestBody.slotOfAvailabilityWeeklyId =
          selectedSlot.slotOfAvailabilityId;
      } else {
        requestBody.slotOfAvailabilityCustomId =
          selectedSlot.slotOfAvailabilityId;
      }

      const response = await fetch("/api/slots/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to submit request for approval");
      }

      toast({
        title: "Request Submitted",
        description:
          "Your request for approval has been submitted successfully. The consultant will review and respond soon.",
        variant: "default",
      });

      // Clear the selected slot
      setSelectedSlot(null);
    } catch (error) {
      console.error("Error requesting approval:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to submit request for approval",
        variant: "destructive",
      });
    } finally {
      setIsRequestingApproval(false);
    }
  };

  const handleBookNowClick = () => {
    const today = new Date();
    setSelectedDate(today);
    setCurrentDate(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  if (consultationOptions.length === 0 && subscriptionOptions.length === 0) {
    return (
      <div className="w-full max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
        <div className="text-center text-gray-300">
          <p>No pricing options available at the moment.</p>
        </div>
      </div>
    );
  }

  if (
    session?.user?.role &&
    ["consultant", "staff"].includes(session.user.role.toLowerCase())
  ) {
    return (
      <div className="w-full max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
        <div className="text-center text-gray-300 space-y-3">
          <h3 className="text-2xl font-medium tracking-tight">
            Consultee Access Required
          </h3>
          <p className="text-gray-400">
            To book consultations or subscribe to services, please sign in with
            a consultee account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-8"
      >
        <TabsList className="inline-flex p-1.5 bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700/50 shadow-lg">
          {consultationOptions.length > 0 && (
            <TabsTrigger
              value="consultation"
              className={`${
                activeTab === "consultation"
                  ? "bg-white text-black shadow-sm"
                  : "text-gray-200 hover:text-white hover:bg-gray-700/50"
              } px-6 py-2.5 rounded-xl font-medium transition-all duration-200 ease-out`}
            >
              Consultation
            </TabsTrigger>
          )}
          {subscriptionOptions.length > 0 && (
            <TabsTrigger
              value="subscription"
              className={`${
                activeTab === "subscription"
                  ? "bg-white text-black shadow-sm"
                  : "text-gray-200 hover:text-white hover:bg-gray-700/50"
              } px-6 py-2.5 rounded-xl font-medium transition-all duration-200 ease-out`}
            >
              Subscription
            </TabsTrigger>
          )}
        </TabsList>

        {consultationOptions.length > 0 && (
          <TabsContent value="consultation">
            <Tabs
              value={activeConsultationOption}
              onValueChange={setActiveConsultationOption}
              className="space-y-8"
            >
              <TabsList className="inline-flex p-1 bg-gray-800/30 backdrop-blur-sm rounded-xl border border-gray-700/30 shadow-md">
                {consultationOptions.map((option) => (
                  <TabsTrigger
                    key={option.title}
                    value={option.title.toLowerCase().replace(" ", "-")}
                    className={`${
                      activeConsultationOption ===
                      option.title.toLowerCase().replace(" ", "-")
                        ? "bg-white text-black shadow-sm"
                        : "text-gray-300 hover:text-white hover:bg-gray-700/30"
                    } px-5 py-2 rounded-lg font-medium transition-all duration-200 ease-out`}
                  >
                    {option.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="grid grid-cols-1 gap-6">
                {consultationOptions.map((option) => (
                  <motion.div
                    key={option.title}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{
                      opacity:
                        activeConsultationOption ===
                        option.title.toLowerCase().replace(" ", "-")
                          ? 1
                          : 0,
                      y: 0,
                    }}
                    transition={{ duration: 0.3 }}
                    className={
                      activeConsultationOption ===
                      option.title.toLowerCase().replace(" ", "-")
                        ? "block"
                        : "hidden"
                    }
                  >
                    <Card className="bg-gray-800/50 border-gray-700 shadow-lg hover:shadow-xl transition-all duration-300 backdrop-blur-sm">
                      <CardHeader>
                        <CardTitle className="text-2xl font-bold text-white">
                          {option.title}
                        </CardTitle>
                        <CardDescription className="text-gray-300">
                          {option.description}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <div className="text-5xl font-bold text-white">
                          ${option.price}
                        </div>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="outline"
                              className="w-full bg-white text-black hover:bg-gray-100 transition-colors duration-300"
                              onClick={handleBookNowClick}
                            >
                              Book Now
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="sm:max-w-[425px] lg:max-w-[700px] bg-[#15171B] text-white p-0 border-0 rounded-lg">
                            <DialogHeader className="p-6 border-b border-gray-800">
                              <DialogTitle>
                                Book {option.title} Consultation
                              </DialogTitle>
                              <DialogDescription className="text-gray-400">
                                Select a date and time for your{" "}
                                {option.duration} consultation
                              </DialogDescription>
                            </DialogHeader>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
                              {/* Calendar Section */}
                              <div>
                                <h3 className="text-lg font-semibold mb-4 flex items-center">
                                  <CalendarIcon className="mr-2 h-5 w-5" />{" "}
                                  Select a Date
                                </h3>
                                <div className="calendar-container bg-gray-800/60 p-4 rounded-lg">
                                  <div className="flex justify-between items-center mb-4">
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        setCurrentDate(
                                          new Date(
                                            currentDate.getFullYear(),
                                            currentDate.getMonth() - 1,
                                            1,
                                          ),
                                        )
                                      }
                                    >
                                      &lt;
                                    </Button>
                                    <span className="font-semibold">
                                      {currentDate.toLocaleString("default", {
                                        month: "long",
                                        year: "numeric",
                                      })}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        setCurrentDate(
                                          new Date(
                                            currentDate.getFullYear(),
                                            currentDate.getMonth() + 1,
                                            1,
                                          ),
                                        )
                                      }
                                    >
                                      &gt;
                                    </Button>
                                  </div>
                                  <div className="grid grid-cols-7 gap-2 text-center text-sm text-gray-400 mb-2">
                                    <div>Mo</div>
                                    <div>Tu</div>
                                    <div>We</div>
                                    <div>Th</div>
                                    <div>Fr</div>
                                    <div>Sa</div>
                                    <div>Su</div>
                                  </div>
                                  <div className="grid grid-cols-7 gap-1">
                                    {renderCalendar()}
                                  </div>
                                </div>
                              </div>

                              {/* Available Slots Section */}
                              <div>
                                <h3 className="text-lg font-semibold mb-4 flex items-center">
                                  <ClockIcon className="mr-2 h-5 w-5" />{" "}
                                  Available {selectedDuration} hour Slots
                                </h3>
                                <div className="grid grid-cols-1 gap-2.5 max-h-[280px] overflow-y-auto pr-2">
                                  {availableSlots.length > 0 ? (
                                    availableSlots.map((slot, index) => {
                                      const isSelected =
                                        selectedSlot?.slotId === slot.slotId &&
                                        selectedSlot?.localStartTime ===
                                          slot.localStartTime;

                                      const isAllocated = slot.isAllocated;

                                      return (
                                        <button
                                          key={`${slot.slotId}-${index}`}
                                          disabled={false} // Allow clicking on all slots
                                          className={`w-full justify-center p-3 text-sm font-medium transition-all duration-200 rounded-lg text-left
                                            ${
                                              isSelected
                                                ? "bg-white text-black shadow-md"
                                                : isAllocated
                                                  ? "bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20"
                                                  : "bg-gray-800/60 text-gray-200 border border-gray-700/50 hover:bg-gray-700/80"
                                            }`}
                                          onClick={() => {
                                            setSelectedSlot(slot); // Allow selecting any slot
                                          }}
                                        >
                                          <div className="flex items-center">
                                            <ClockIcon className="mr-3 h-4 w-4 opacity-80" />
                                            <span>
                                              {slot.localStartTime} -{" "}
                                              {slot.localEndTime}
                                            </span>
                                            {isAllocated && (
                                              <span className="ml-auto text-xs font-semibold">
                                                Request for approval
                                              </span>
                                            )}
                                          </div>
                                        </button>
                                      );
                                    })
                                  ) : (
                                    <p className="text-gray-400 text-sm">
                                      No available slots for the selected date.
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="bg-gray-800/50 px-6 py-4 flex justify-end rounded-b-lg">
                              <Button
                                className="w-full sm:w-auto"
                                onClick={
                                  selectedSlot?.isAllocated
                                    ? handleRequestForApproval
                                    : handleConsultationBooking
                                }
                                disabled={!selectedSlot || isRequestingApproval}
                              >
                                {isRequestingApproval
                                  ? "Submitting..."
                                  : selectedSlot?.isAllocated
                                    ? "Request for Approval"
                                    : "Continue to Checkout"}
                              </Button>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </Tabs>
          </TabsContent>
        )}

        {subscriptionOptions.length > 0 && (
          <TabsContent value="subscription">
            <Tabs
              value={activeSubscriptionOption}
              onValueChange={setActiveSubscriptionOption}
              className="space-y-8"
            >
              <TabsList className="inline-flex p-1 bg-gray-800/30 backdrop-blur-sm rounded-xl border border-gray-700/30 shadow-md">
                {subscriptionOptions.map((option) => (
                  <TabsTrigger
                    key={option.title}
                    value={option.title.toLowerCase().replace(" ", "-")}
                    className={`${
                      activeSubscriptionOption ===
                      option.title.toLowerCase().replace(" ", "-")
                        ? "bg-white text-black shadow-sm"
                        : "text-gray-300 hover:text-white hover:bg-gray-700/30"
                    } px-5 py-2 rounded-lg font-medium transition-all duration-200 ease-out`}
                  >
                    {option.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="grid grid-cols-1 gap-6">
                {subscriptionOptions.map((option) => (
                  <motion.div
                    key={option.title}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{
                      opacity:
                        activeSubscriptionOption ===
                        option.title.toLowerCase().replace(" ", "-")
                          ? 1
                          : 0,
                      y: 0,
                    }}
                    transition={{ duration: 0.3 }}
                    className={
                      activeSubscriptionOption ===
                      option.title.toLowerCase().replace(" ", "-")
                        ? "block"
                        : "hidden"
                    }
                  >
                    <Card className="bg-gray-800/50 border-gray-700 shadow-lg hover:shadow-xl transition-all duration-300 backdrop-blur-sm">
                      <CardHeader>
                        <CardTitle className="text-2xl font-bold text-white">
                          {option.title}
                        </CardTitle>
                        <CardDescription className="text-gray-300">
                          {option.description}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <div className="text-5xl font-bold text-white">
                          ${option.price}
                        </div>
                        <div className="space-y-2">
                          <p className="text-white">Includes:</p>
                          <ul className="space-y-1 pl-4">
                            {option.features?.map((feature, index) => (
                              <li
                                key={`feature-${index}`}
                                className="text-gray-300 flex items-center"
                              >
                                <svg
                                  className="w-4 h-4 mr-2 text-white"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                  xmlns="http://www.w3.org/2000/svg"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                                {feature}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <Button
                          variant="outline"
                          className="w-full bg-white text-black hover:bg-gray-100 transition-colors duration-300"
                          onClick={() => handleSubscriptionBooking(option)}
                        >
                          Choose Plan
                        </Button>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </Tabs>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
