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
import { ClockIcon, CheckCircle2, RefreshCw } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { requireJsonResponse } from "@/lib/fetch-helpers";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PricingOption } from "../defaults";
import { TIntervalTiming } from "@/types/slots";
import { breakDownSlotsPreservingStatus } from "@/utils/scheduling-engine/intervals";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import {
  consumePurchaseIntent,
  stashPurchaseIntent,
} from "@/utils/purchase-intent";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import type { BookingMode } from "@prisma/client";
import {
  CONSULTANT_PAUSED_HINT,
  consultationCtaFor,
} from "@/lib/booking/booking-mode";
import { SlotList } from "./SlotList";
import type { SlotWithStatus } from "./slot-list-policy";

interface ConsultantDetailsForBooking {
  id: string;
  scheduleType?: string;
  /** #1703 D1 — absent on older payloads; INSTANT is the pre-#1703 behaviour. */
  bookingMode?: BookingMode;
  /** #1703 D4 — false while the expert has paused new requests. */
  acceptingRequests?: boolean;
  consultationPlans: Array<{
    id: string;
    durationInHours: number;
  }>;
}

interface ConsultationPricingToggleProps {
  consultationOptions: PricingOption[];
  consultantDetails: ConsultantDetailsForBooking;
  handleConsultationBooking: (consultationPlanId: string) => void;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: (durationInHours: number) => JSX.Element[];
  slotTimings: TIntervalTiming[];
  selectedSlot: TIntervalTiming | null;
  setSelectedSlot: (slot: TIntervalTiming | null) => void;
  timezone: string;
  onRefreshSlots?: () => void;
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
  onRefreshSlots,
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  // Track the active plan by id so plans that share a duration (e.g. two
  // 1-hour consultations) remain independently selectable and bookable.
  const [activeConsultationOption, setActiveConsultationOption] =
    useState<string>(consultationOptions[0]?.id ?? "");
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const activePlanOption = useMemo(
    () =>
      consultationOptions.find((opt) => opt.id === activeConsultationOption),
    [activeConsultationOption, consultationOptions],
  );

  const selectedDuration = activePlanOption?.durationInHours ?? 1;

  // #1703 D1 — REQUEST routes every slot through approval; INSTANT keeps the
  // contended-slot-only arm. Decided once here so the button and its hint agree.
  const cta = consultationCtaFor(
    consultantDetails.bookingMode ?? "INSTANT",
    selectedSlot?.isAllocated ?? false,
  );
  const paused =
    cta.action === "request" && consultantDetails.acceptingRequests === false;

  const availableSlots = useMemo((): SlotWithStatus[] => {
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
      bookingStatus: (slot.bookingStatus || "available") as
        | "available"
        | "partially-booked"
        | "fully-booked",
    }));

    // Use breakDownSlotsPreservingStatus to create duration windows
    // WITHOUT discarding the API-computed bookingStatus
    const brokenDownSlots = breakDownSlotsPreservingStatus(
      slotsWithAllocation,
      selectedDuration,
      timezone,
    );

    // Add client-side past-slot detection
    const now = Date.now();
    return brokenDownSlots.map((slot) => ({
      ...slot,
      _isPast:
        new Date(slot.startsAt).getTime() < now + MINIMUM_BOOKING_LEAD_TIME_MS,
    }));
  }, [slotTimings, selectedDuration, timezone, selectedDate]);

  // #booking-journey — restore a slot stashed before the auth bounce. Runs
  // once per mount, and only once slots have actually loaded: the stashed
  // pick is only applied when it still exists in the calendar (not past, not
  // fully booked), so a stale intent can never select an invalid slot.
  const purchaseIntentConsumedRef = useRef(false);
  useEffect(() => {
    if (purchaseIntentConsumedRef.current) return;
    if (availableSlots.length === 0 || !session?.user?.id) return;
    purchaseIntentConsumedRef.current = true;

    const intent = consumePurchaseIntent(consultantDetails.id);
    if (!intent) return;

    if (
      consultationOptions.some((opt) => opt.id === intent.consultationPlanId)
    ) {
      setActiveConsultationOption(intent.consultationPlanId);
    }

    const match = availableSlots.find(
      (slot) =>
        slot.startsAt === intent.slot.startsAt &&
        slot.endsAt === intent.slot.endsAt &&
        !slot._isPast &&
        slot.bookingStatus !== "fully-booked",
    );
    if (match) {
      setSelectedSlot(match);
      toast({
        title: "Welcome back",
        description: "Your previously selected time slot was restored.",
      });
    }
  }, [
    availableSlots,
    consultationOptions,
    consultantDetails.id,
    session?.user?.id,
    setActiveConsultationOption,
    setSelectedSlot,
    toast,
  ]);

  const handleRequestForApproval = async () => {
    if (!selectedSlot || !consultantDetails) {
      toast({ title: "Please select a time slot", variant: "destructive" });
      return;
    }

    if (!session?.user?.id) {
      // B9 (booking-journey audit) — redirect to sign-in with a callback URL
      // instead of dead-ending in a toast. The Buy path already does this
      // implicitly: /checkout/* is middleware-protected and bounces here with
      // callbackUrl. The request-for-approval path runs client-side, so it
      // must build the same redirect itself or guests hit a wall.
      //
      // #booking-journey — the profile-page callbackUrl alone would lose the
      // picked slot (the user returns to an unselected calendar). Stash the
      // full selection in sessionStorage; ConsultationPricingToggle restores
      // it on the next authenticated render.
      stashPurchaseIntent({
        consultantId: consultantDetails.id,
        consultationPlanId: activeConsultationOption,
        slot: {
          startsAt: selectedSlot.startsAt,
          endsAt: selectedSlot.endsAt,
          type: (
            selectedSlot as TIntervalTiming & { type?: "WEEKLY" | "CUSTOM" }
          ).type,
          availabilityWindowId: (
            selectedSlot as TIntervalTiming & { availabilityWindowId?: string }
          ).availabilityWindowId,
        },
      });
      const callbackUrl = `${window.location.pathname}${window.location.search}`;
      router.push(
        `/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      );
      return;
    }

    // Look up the plan by the user's active tab selection (not by slot
    // duration) so duplicate-duration plans resolve to the correct one.
    const activePlan = consultantDetails.consultationPlans.find(
      (plan: { id: string; durationInHours: number }) =>
        plan.id === activeConsultationOption,
    );

    if (!activePlan) {
      toast({ title: "Invalid consultation plan", variant: "destructive" });
      return;
    }

    setIsRequestingApproval(true);

    try {
      const requestBody: {
        consultantProfileId: string;
        startsAt: string;
        endsAt: string;
        consultationPlanId: string;
        availabilityWindowWeeklyId?: string;
        availabilityWindowCustomId?: string;
      } = {
        consultantProfileId: consultantDetails.id,
        startsAt: selectedSlot.startsAt,
        endsAt: selectedSlot.endsAt,
        consultationPlanId: activePlan.id,
      };

      if (selectedSlot.type === "WEEKLY") {
        requestBody.availabilityWindowWeeklyId =
          selectedSlot.availabilityWindowId;
      } else {
        requestBody.availabilityWindowCustomId =
          selectedSlot.availabilityWindowId;
      }

      const response = await fetch("/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      // Never bare response.json(): an edge 504/HTML page would throw a
      // SyntaxError into the toast instead of the server's reason.
      // requireJsonResponse throws on !ok, so reaching here means success.
      await requireJsonResponse(
        response,
        "Failed to submit request for approval",
      );

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
        title: "Couldn't submit approval request",
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
    setSelectedSlot(null);
    setCurrentDate(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  const handlePlanChange = (planId: string) => {
    setActiveConsultationOption(planId);
    setSelectedSlot(null);
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
      onValueChange={handlePlanChange}
      className="w-full space-y-5"
    >
      {/* Segmented pill duration toggle */}
      <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm h-auto">
        {consultationOptions.map((option) => {
          const isActive = activeConsultationOption === option.id;
          return (
            <TabsTrigger
              key={option.id}
              value={option.id}
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
        {consultationOptions.map((option) => {
          const isActive = activeConsultationOption === option.id;
          return (
            <motion.div
              key={option.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{
                opacity: isActive ? 1 : 0,
                y: 0,
              }}
              transition={{ duration: 0.2 }}
              className={isActive ? "block" : "hidden"}
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

              {/* Two CTAs: read first, or book now. The toggle stays a chooser
                and hands detail off to the plan page. */}
              <Button
                asChild
                variant="outline"
                className="w-full mb-3 bg-white/[0.05] border border-white/[0.12] text-zinc-200 hover:bg-white/[0.10] hover:text-white font-medium rounded-xl h-11 text-sm transition-all duration-200"
              >
                <Link
                  href={`/explore/programs/plans/consultations/${option.id}`}
                >
                  Open details
                </Link>
              </Button>

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
                          <span className="font-semibold text-white text-lg">
                            {currentDate.toLocaleString("default", {
                              month: "long",
                              year: "numeric",
                            })}
                          </span>
                          <div className="flex items-center gap-1">
                            {/* #1785 L-4 — back to the current month and today's date. */}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-9 rounded-lg border border-zinc-600 bg-zinc-800/30 px-3 text-zinc-200 hover:border-zinc-400 hover:bg-zinc-700/50 hover:text-white"
                              onClick={handleBookNowClick}
                            >
                              Today
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="default"
                              aria-label="Previous month"
                              className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-9 w-9 text-lg"
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
                            <Button
                              type="button"
                              variant="ghost"
                              size="default"
                              aria-label="Next month"
                              className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-9 w-9 text-lg"
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
                          {renderCalendar(selectedDuration)}
                        </div>
                      </div>
                    </div>

                    {/* Available Slots Section */}
                    <div>
                      <div className="flex items-center justify-between mb-5">
                        <h3 className="text-lg font-semibold flex items-center text-white">
                          <ClockIcon className="mr-2 h-5 w-5 text-zinc-400" />{" "}
                          Available {selectedDuration} hour Slots
                        </h3>
                        {onRefreshSlots && (
                          <button
                            type="button"
                            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700/50 transition-colors"
                            title="Refresh slot availability"
                            onClick={async () => {
                              setIsRefreshing(true);
                              try {
                                await onRefreshSlots();
                              } finally {
                                setIsRefreshing(false);
                              }
                            }}
                            disabled={isRefreshing}
                          >
                            <RefreshCw
                              className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
                            />
                          </button>
                        )}
                      </div>
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
                        <SlotList
                          slots={availableSlots}
                          selectedSlot={selectedSlot as SlotWithStatus | null}
                          onSelect={setSelectedSlot}
                          bookingMode={
                            consultantDetails.bookingMode ?? "INSTANT"
                          }
                        />
                      </div>
                    </div>
                  </div>
                  <div className="bg-zinc-800/50 px-6 lg:px-8 py-5 flex flex-col items-end gap-2 rounded-b-2xl border-t border-zinc-800">
                    {(paused || cta.hint) && (
                      <p className="text-xs text-zinc-400 text-right">
                        {paused ? CONSULTANT_PAUSED_HINT : cta.hint}
                      </p>
                    )}
                    <Button
                      className="bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-8 h-12 text-base"
                      onClick={
                        cta.action === "request"
                          ? handleRequestForApproval
                          : () => handleConsultationBooking(option.id)
                      }
                      disabled={
                        !selectedSlot ||
                        paused ||
                        isRequestingApproval ||
                        (selectedSlot as SlotWithStatus)?._isPast ||
                        selectedSlot?.bookingStatus === "fully-booked"
                      }
                    >
                      {isRequestingApproval ? "Submitting..." : cta.label}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </motion.div>
          );
        })}
      </div>
    </Tabs>
  );
}
