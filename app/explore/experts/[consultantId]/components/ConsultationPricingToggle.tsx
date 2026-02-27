"use client";

import { CalendarIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { ClockIcon, CheckCircle2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useMemo, useState } from "react";
import { PricingOption } from "../defaults";
import { TSlotTiming } from "@/types/slots";
import {
  breakDownSlotsByDuration,
  mergeConsecutiveSlots,
} from "@/utils/timeSlotsProcessing";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";

interface ConsultationPricingToggleProps {
  consultationOptions: PricingOption[];
  consultantDetails: any;
  handleConsultationBooking: () => void;
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

export default function ConsultationPricingToggle({
  consultationOptions,
  handleConsultationBooking,
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
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  const [activeConsultationOption, setActiveConsultationOption] = useState(
    consultationOptions.length > 0
      ? consultationOptions[0].title.toLowerCase().replace(" ", "-")
      : "",
  );
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);

  const selectedDuration = useMemo(() => {
    const option = consultationOptions.find(
      (opt) =>
        opt.title.toLowerCase().replace(" ", "-") === activeConsultationOption,
    );
    return option?.durationInHours ?? 1;
  }, [activeConsultationOption, consultationOptions]);

  const availableSlots = useMemo(() => {
    if (
      !slotTimings ||
      slotTimings.length === 0 ||
      !timezone ||
      !selectedDate
    ) {
      return [];
    }

    const slotsWithAllocation = slotTimings.map((slot) => ({
      ...slot,
      isAllocated: slot.isAllocated || false,
    }));

    const mergedSlots = mergeConsecutiveSlots(slotsWithAllocation);
    const brokenDownSlots = breakDownSlotsByDuration(
      mergedSlots,
      selectedDuration,
      [],
      timezone,
    );

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

    const startTime = new Date(selectedSlot.slotStartTimeInUTC);
    const endTime = new Date(selectedSlot.slotEndTimeInUTC);
    const durationInHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

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

  if (consultationOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-zinc-400">
        <p>No consultation plans available at the moment.</p>
      </div>
    );
  }

  if (
    session?.user?.role &&
    ["consultant", "staff"].includes(session.user.role.toLowerCase())
  ) {
    return (
      <div className="w-full p-8 text-center space-y-3">
        <h3 className="text-2xl font-medium tracking-tight text-zinc-300">
          Consultee Access Required
        </h3>
        <p className="text-zinc-500">
          To book consultations, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={activeConsultationOption}
      onValueChange={setActiveConsultationOption}
      className="w-full space-y-5"
    >
      {/* Segmented pill duration toggle */}
      <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm h-auto">
        {consultationOptions.map((option) => {
          const isActive =
            activeConsultationOption ===
            option.title.toLowerCase().replace(" ", "-");
          return (
            <TabsTrigger
              key={option.durationInHours}
              value={option.title.toLowerCase().replace(" ", "-")}
              className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-zinc-400 transition-colors duration-300 z-10 h-auto whitespace-nowrap"
            >
              {isActive && (
                <motion.div
                  layoutId="consultation-duration-pill"
                  className="absolute inset-0 bg-white rounded-xl shadow-sm"
                  transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
                />
              )}
              <span className="relative z-10">{option.title}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="grid grid-cols-1 gap-4">
        {consultationOptions.map((option) => (
          <motion.div
            key={option.durationInHours}
            initial={{ opacity: 0, y: 10 }}
            animate={{
              opacity:
                activeConsultationOption ===
                option.title.toLowerCase().replace(" ", "-")
                  ? 1
                  : 0,
              y: 0,
            }}
            transition={{ duration: 0.2 }}
            className={
              activeConsultationOption ===
              option.title.toLowerCase().replace(" ", "-")
                ? "block"
                : "hidden"
            }
          >
            {/* Pricing content — no nested dark card, lives directly in glass parent */}
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-white">{option.title}</h3>
              <p className="text-xs text-zinc-500">{option.description}</p>
            </div>

            <div className="flex items-end gap-2 my-5">
              <span className="text-5xl font-bold tracking-tight text-white">
                {formatPrice(option.price)}
              </span>
              <span className="text-zinc-500 text-sm mb-1.5">/ session</span>
            </div>

            {option.features && option.features.length > 0 && (
              <>
                <div className="border-t border-white/[0.06] mb-4" />
                <div className="space-y-2 mb-5">
                  <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">
                    Includes
                  </p>
                  <ul className="space-y-2">
                    {option.features.map((feature, index) => (
                      <li
                        key={`feature-${index}`}
                        className="text-zinc-200 flex items-center text-sm"
                      >
                        <CheckCircle2 className="w-4 h-4 mr-2.5 text-emerald-400 flex-shrink-0" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            <Dialog>
              <DialogTrigger asChild>
                <Button
                  className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-semibold rounded-xl h-12 text-sm tracking-wide transition-all duration-200 hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
                  onClick={handleBookNowClick}
                >
                  Book Now
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[700px] lg:max-w-[950px] xl:max-w-[1050px] max-h-[85vh] overflow-y-auto bg-zinc-900 text-white p-0 border border-zinc-800 rounded-2xl shadow-2xl">
                <DialogHeader className="p-6 lg:p-8 border-b border-zinc-800">
                  <DialogTitle className="text-xl lg:text-2xl font-semibold">
                    Book {option.title} Consultation
                  </DialogTitle>
                  <DialogDescription className="text-zinc-400 text-base">
                    Select a date and time for your {option.duration}{" "}
                    consultation
                  </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-10 p-6 lg:p-8">
                  {/* Calendar Section */}
                  <div>
                    <h3 className="text-lg font-semibold mb-5 flex items-center text-white">
                      <CalendarIcon className="mr-2 h-5 w-5 text-zinc-400" />{" "}
                      Select a Date
                    </h3>
                    <div className="bg-zinc-800/60 p-5 lg:p-6 rounded-xl border border-zinc-700/50">
                      <div className="flex justify-between items-center mb-5">
                        <Button
                          variant="ghost"
                          size="default"
                          className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-10 w-10 text-lg"
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
                        <span className="font-semibold text-white text-lg">
                          {currentDate.toLocaleString("default", {
                            month: "long",
                            year: "numeric",
                          })}
                        </span>
                        <Button
                          variant="ghost"
                          size="default"
                          className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-10 w-10 text-lg"
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
                      <div className="grid grid-cols-7 gap-3 text-center text-base font-medium text-zinc-400 mb-3">
                        <div>Mo</div>
                        <div>Tu</div>
                        <div>We</div>
                        <div>Th</div>
                        <div>Fr</div>
                        <div>Sa</div>
                        <div>Su</div>
                      </div>
                      <div className="grid grid-cols-7 gap-2">
                        {renderCalendar()}
                      </div>
                    </div>
                  </div>

                  {/* Available Slots Section */}
                  <div>
                    <h3 className="text-lg font-semibold mb-5 flex items-center text-white">
                      <ClockIcon className="mr-2 h-5 w-5 text-zinc-400" />{" "}
                      Available {selectedDuration} hour Slots
                    </h3>
                    {consultantDetails?.scheduleType && (
                      <div className="mb-4 p-3 bg-zinc-800/40 rounded-xl border border-zinc-700/50">
                        <p className="text-sm text-zinc-400">
                          This consultant prefers{" "}
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium ${
                              consultantDetails.scheduleType === "WEEKLY"
                                ? "bg-zinc-700 text-zinc-300"
                                : "bg-zinc-700 text-zinc-300"
                            }`}
                          >
                            {consultantDetails.scheduleType === "WEEKLY"
                              ? "📅 Weekly"
                              : "🎯 Custom"}
                          </span>{" "}
                          scheduling
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-3 max-h-[350px] overflow-y-auto pr-2">
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
                              className={`w-full p-4 text-base font-medium transition-all duration-200 rounded-xl text-left
                                  ${
                                    isSelected
                                      ? "bg-white text-zinc-900 shadow-md"
                                      : isAllocated
                                        ? "bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20"
                                        : "bg-zinc-800/60 text-zinc-300 border border-zinc-700/50 hover:bg-zinc-700/80 hover:border-zinc-600"
                                  }`}
                              onClick={() => setSelectedSlot(slot)}
                            >
                              <div className="flex items-center">
                                <ClockIcon className="mr-3 h-5 w-5 opacity-70" />
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span>
                                      {slot.localStartTime} -{" "}
                                      {slot.localEndTime}
                                    </span>
                                    {slot.type && (
                                      <span className="px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400">
                                        {slot.type === "WEEKLY" ? "📅" : "🎯"}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                {isAllocated && (
                                  <span className="ml-auto text-sm font-medium">
                                    Request approval
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })
                      ) : (
                        <p className="text-zinc-500 text-sm py-4 text-center">
                          No available slots for the selected date.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="bg-zinc-800/50 px-6 lg:px-8 py-5 flex justify-end rounded-b-2xl border-t border-zinc-800">
                  <Button
                    className="bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-8 h-12 text-base"
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
          </motion.div>
        ))}
      </div>
    </Tabs>
  );
}
