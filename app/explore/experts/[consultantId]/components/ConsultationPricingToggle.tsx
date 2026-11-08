"use client";

import { leadMsForPlan } from "@/lib/booking/lead-time";
import {
  HELD_BY_SOMEONE_ELSE,
  NotifyWhenFreeButton,
  type BackupWindowRequest,
} from "@/components/booking/NotifyWhenFreeButton";
import { CalendarIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as Sentry from "@sentry/nextjs";
import { motion } from "framer-motion";
import { ClockIcon, CheckCircle2, RefreshCw } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PricingOption } from "../defaults";
import { TIntervalTiming } from "@/types/slots";
import { useNowTick } from "@/hooks/use-now-tick";
import { useJustTaken } from "@/lib/scheduling/use-just-taken";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import type { DisplayZone } from "@/lib/time/use-display-zone";
import { calendarDayOf } from "@/lib/time/grid-zone";
import {
  consumePurchaseIntent,
  stashPurchaseIntent,
} from "@/utils/purchase-intent";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { BookingMode } from "@prisma/client";
import {
  CONSULTANT_PAUSED_HINT,
  consultationCtaFor,
} from "@/lib/booking/booking-mode";
import { SlotList } from "./SlotList";
import { durationPhrase } from "./slot-list-policy";
import {
  isBookableWindow,
  sameWindow,
  windowsForDay,
  type SlotWithStatus,
} from "@/lib/scheduling/booking-windows";

/** What the dialog says when a poll or the server shows the pick is gone. */
export const TIME_JUST_TAKEN_MESSAGE =
  "That time was just taken — pick another.";

interface ConsultantDetailsForBooking {
  id: string;
  /** #1703 D1 — absent on older payloads; INSTANT is the pre-#1703 behaviour. */
  bookingMode?: BookingMode;
  /** False while the expert has paused new bookings of every kind. */
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
  renderCalendar: () => JSX.Element[];
  slotTimings: TIntervalTiming[];
  /** True once the selected day's read has answered, so an absent pick means gone. */
  slotsReady: boolean;
  selectedSlot: TIntervalTiming | null;
  setSelectedSlot: (slot: TIntervalTiming | null) => void;
  /** The zone every time in the dialog is drawn in, with its device-zone switch. */
  displayZone: DisplayZone;
  onRefreshSlots?: () => void;
  onDurationChange?: (durationInHours: number) => void;
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
  slotsReady,
  selectedSlot,
  setSelectedSlot,
  displayZone,
  consultantDetails,
  onRefreshSlots,
  onDurationChange,
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  const timezone = displayZone.zone;
  // The lead-time cut moves with the clock, not only with new data: a 304
  // poll keeps the data's identity, and a time crossing the 15-minute lead
  // must still leave the list.
  const now = useNowTick(60_000);
  // Track the active plan by id so plans that share a duration (e.g. two
  // 1-hour consultations) remain independently selectable and bookable.
  const [activeConsultationOption, setActiveConsultationOption] =
    useState<string>(consultationOptions[0]?.id ?? "");
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);
  // #1778 — the window another learner holds, offered as "notify me".
  const [heldWindow, setHeldWindow] = useState<BackupWindowRequest | null>(
    null,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);

  const activePlanOption = useMemo(
    () =>
      consultationOptions.find((opt) => opt.id === activeConsultationOption),
    [activeConsultationOption, consultationOptions],
  );

  const selectedDuration = activePlanOption?.durationInHours ?? 1;
  // The list never offers a time request-for-approval refuses.
  const requestMode =
    (consultantDetails.bookingMode ?? "INSTANT") === "REQUEST";
  const leadMs = leadMsForPlan(requestMode, activePlanOption?.price);

  useEffect(() => {
    onDurationChange?.(selectedDuration);
  }, [selectedDuration, onDurationChange]);

  const paused = consultantDetails.acceptingRequests === false;

  const availableSlots = useMemo((): SlotWithStatus[] => {
    if (!slotTimings || slotTimings.length === 0 || !selectedDate) return [];
    return windowsForDay(
      slotTimings,
      selectedDuration,
      timezone,
      now.getTime(),
      leadMs,
    );
  }, [slotTimings, selectedDuration, timezone, selectedDate, now, leadMs]);

  // The pick is re-read from the latest windows every render; the CTA only
  // ever acts on this live copy, never on the object the buyer clicked.
  const liveSelection = useMemo(() => {
    if (!selectedSlot) return null;
    const live = availableSlots.find((slot) => sameWindow(slot, selectedSlot));
    return live && isBookableWindow(live) ? live : null;
  }, [availableSlots, selectedSlot]);
  const staleSelection =
    selectedSlot !== null && slotsReady && liveSelection === null
      ? [selectedSlot.startsAt]
      : [];
  const dropTakenSelection = useCallback(() => {
    setSelectedSlot(null);
    toast({ title: TIME_JUST_TAKEN_MESSAGE, variant: "destructive" });
  }, [setSelectedSlot, toast]);
  const justTakenKeys = useJustTaken(staleSelection, dropTakenSelection);
  const justTakenSlot: SlotWithStatus | null =
    selectedSlot && justTakenKeys.has(selectedSlot.startsAt)
      ? {
          ...selectedSlot,
          isAllocated: selectedSlot.isAllocated ?? false,
          bookingStatus: selectedSlot.bookingStatus ?? "available",
          _isPast: false,
        }
      : null;

  // #1703 D1 — REQUEST routes every slot through approval; INSTANT keeps the
  // contended-slot-only arm. Decided once here so the button and its hint agree.
  const cta = consultationCtaFor(
    consultantDetails.bookingMode ?? "INSTANT",
    liveSelection?.isAllocated ?? false,
  );

  // #booking-journey — restore a slot stashed before the auth bounce. Runs
  // once per mount, and only once slots have actually loaded: the stashed
  // pick is only applied when it still exists in the calendar (not past, not
  // fully booked), so a stale intent can never select an invalid slot.
  const purchaseIntentConsumedRef = useRef(false);
  // One Idempotency-Key per (plan, slot) attempt; a retry of the same attempt resends it.
  const requestAttemptRef = useRef<{ selection: string; key: string } | null>(
    null,
  );
  useEffect(() => {
    if (purchaseIntentConsumedRef.current) return;
    if (availableSlots.length === 0 || !session?.user?.id) return;
    purchaseIntentConsumedRef.current = true;

    const intent = consumePurchaseIntent(consultantDetails.id);
    if (!intent) return;

    const intentPlan = consultationOptions.find(
      (opt) => opt.id === intent.consultationPlanId,
    );
    if (intentPlan) setActiveConsultationOption(intentPlan.id);

    // Matched against the intent plan's own windows and lead, so the restored
    // pick is still live once the plan tab switches to it.
    const match = windowsForDay(
      slotTimings,
      intentPlan?.durationInHours ?? selectedDuration,
      timezone,
      Date.now(),
      intentPlan ? leadMsForPlan(requestMode, intentPlan.price) : leadMs,
    ).find((slot) => sameWindow(slot, intent.slot) && isBookableWindow(slot));
    if (match) {
      setSelectedSlot(match);
      toast({
        title: "Welcome back",
        description: "The time you picked before signing in is still free.",
      });
    }
  }, [
    availableSlots,
    slotTimings,
    selectedDuration,
    timezone,
    leadMs,
    requestMode,
    consultationOptions,
    consultantDetails.id,
    session?.user?.id,
    setActiveConsultationOption,
    setSelectedSlot,
    toast,
  ]);

  const handleRequestForApproval = async () => {
    const pick = liveSelection;
    if (!pick || !consultantDetails) {
      toast({ title: "Pick a time first", variant: "destructive" });
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
          startsAt: pick.startsAt,
          endsAt: pick.endsAt,
          type: pick.type,
          availabilityWindowId: pick.availabilityWindowId,
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
      toast({
        title: "This consultation isn't available right now",
        variant: "destructive",
      });
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
        startsAt: pick.startsAt,
        endsAt: pick.endsAt,
        consultationPlanId: activePlan.id,
      };

      if (pick.type === "WEEKLY") {
        requestBody.availabilityWindowWeeklyId = pick.availabilityWindowId;
      } else {
        requestBody.availabilityWindowCustomId = pick.availabilityWindowId;
      }

      const selection = `${activePlan.id}|${pick.startsAt}|${pick.endsAt}`;
      if (requestAttemptRef.current?.selection !== selection) {
        requestAttemptRef.current = {
          selection,
          key: `rq_${globalThis.crypto.randomUUID().replace(/-/g, "")}`,
        };
      }

      const response = await fetch("/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestAttemptRef.current.key,
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
      requestAttemptRef.current = null;

      toast({
        title: "Request sent",
        description:
          "The expert will confirm or decline soon. You pay only once they confirm.",
        variant: "default",
      });

      setSelectedSlot(null);
    } catch (error) {
      console.warn("Request for approval failed", error);
      if (
        error instanceof ApiResponseError &&
        error.code &&
        HELD_BY_SOMEONE_ELSE.has(error.code)
      ) {
        setHeldWindow({
          consultantProfileId: consultantDetails.id,
          windowStart: pick.startsAt,
          windowEnd: pick.endsAt,
          planKind: "CONSULTATION",
          planId: activePlan.id,
        });
      }
      if (error instanceof ApiResponseError && error.code === "SLOT_TAKEN") {
        setSelectedSlot(null);
        onRefreshSlots?.();
        toast({ title: TIME_JUST_TAKEN_MESSAGE, variant: "destructive" });
        return;
      }
      // A modelled refusal carries a sentence written for the buyer; anything
      // else (a crash, an edge page, no network) gets fixed copy and Sentry.
      const refused =
        isExpectedRefusal(error) &&
        error instanceof ApiResponseError &&
        error.code !== undefined;
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(error, {
          tags: { subsystem: "client", flow: "request-for-approval" },
        });
      }
      toast({
        title: "Couldn't send your request",
        description: refused
          ? userMessageFrom(error)
          : "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setIsRequestingApproval(false);
    }
  };

  const handleBookNowClick = () => {
    const today = calendarDayOf(new Date(), timezone);
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
      onValueChange={(value) => {
        setActiveConsultationOption(value);
        // A pick belongs to one session length; another plan has other windows.
        setSelectedSlot(null);
      }}
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
                  {option.priceCurrency &&
                  option.priceCurrency.toUpperCase() !== "INR"
                    ? formatCurrencyAmount(option.price, option.priceCurrency)
                    : formatPrice(option.price)}
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
                {/* Centred, with a gutter on every side and never taller than the
                    screen: the header and the checkout button stay put and only
                    the middle scrolls. Width steps up with the screen. */}
                <DialogContent className="flex max-h-[min(calc(100dvh-1.5rem),52rem)] w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-white shadow-2xl sm:max-w-[640px] sm:rounded-2xl md:max-w-[880px] lg:max-w-[960px] xl:max-w-[1050px]">
                  <DialogHeader className="shrink-0 border-b border-zinc-800 p-4 pr-12 sm:p-6 sm:pr-14 lg:p-8 lg:pr-14">
                    <DialogTitle className="text-lg sm:text-xl lg:text-2xl font-semibold">
                      Book {option.title} Consultation
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400 text-base">
                      Select a date and time for your {option.duration}{" "}
                      consultation
                    </DialogDescription>
                    <ZoneSwitch
                      zone={displayZone.zone}
                      usingDeviceZone={displayZone.usingDeviceZone}
                      canSwitch={displayZone.canSwitch}
                      onToggle={displayZone.toggle}
                      now={now}
                      className="pt-1 text-zinc-400 [&_button]:text-zinc-100"
                    />
                  </DialogHeader>
                  <DialogBody>
                    <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 md:grid-cols-2 md:gap-8 lg:gap-10 lg:p-8">
                      {/* Calendar Section */}
                      <div className="min-w-0">
                        <h3 className="text-lg font-semibold mb-4 sm:mb-5 flex items-center text-white">
                          <CalendarIcon className="mr-2 h-5 w-5 text-zinc-400" />{" "}
                          Select a Date
                        </h3>
                        <div className="bg-zinc-800/60 p-3 sm:p-5 lg:p-6 rounded-xl border border-zinc-700/50">
                          <div className="flex flex-wrap justify-between items-center gap-2 mb-4 sm:mb-5">
                            <span className="font-semibold text-white text-lg">
                              {currentDate.toLocaleString("default", {
                                month: "long",
                                year: "numeric",
                              })}
                            </span>
                            <div className="flex items-center gap-1">
                              {/* Back to the current month and today's date. */}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-zinc-400 hover:text-white hover:bg-zinc-700/50 h-9 px-3"
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
                          <div className="grid grid-cols-7 gap-1 sm:gap-2 text-center text-sm sm:text-base font-medium text-zinc-400 mb-3">
                            <div>Mo</div>
                            <div>Tu</div>
                            <div>We</div>
                            <div>Th</div>
                            <div>Fr</div>
                            <div>Sa</div>
                            <div>Su</div>
                          </div>
                          <div className="grid grid-cols-7 gap-1 sm:gap-2">
                            {renderCalendar()}
                          </div>
                        </div>
                      </div>

                      {/* Available Slots Section */}
                      <div className="min-w-0">
                        <div className="flex items-center justify-between mb-4 sm:mb-5">
                          <h3 className="text-lg font-semibold flex items-center text-white">
                            <ClockIcon className="mr-2 h-5 w-5 text-zinc-400" />{" "}
                            Available {durationPhrase(selectedDuration)} times
                          </h3>
                          {onRefreshSlots && (
                            <button
                              type="button"
                              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700/50 transition-colors"
                              title="Refresh the available times"
                              aria-label="Refresh the available times"
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
                        <div className="grid grid-cols-1 gap-3">
                          <SlotList
                            slots={availableSlots}
                            selectedSlot={liveSelection}
                            justTaken={justTakenSlot}
                            onSelect={setSelectedSlot}
                            bookingMode={
                              consultantDetails.bookingMode ?? "INSTANT"
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </DialogBody>
                  <div className="shrink-0 bg-zinc-800/50 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 flex flex-col items-stretch sm:items-end gap-2 rounded-b-2xl border-t border-zinc-800">
                    {(paused || cta.hint) && (
                      <p className="text-xs text-zinc-400 text-right">
                        {paused ? CONSULTANT_PAUSED_HINT : cta.hint}
                      </p>
                    )}
                    <Button
                      className="bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-8 h-12 text-base w-full sm:w-auto"
                      onClick={
                        cta.action === "request"
                          ? handleRequestForApproval
                          : () => handleConsultationBooking(option.id)
                      }
                      disabled={
                        !liveSelection || paused || isRequestingApproval
                      }
                    >
                      {isRequestingApproval ? "Submitting..." : cta.label}
                    </Button>
                    {heldWindow &&
                      heldWindow.windowStart === liveSelection?.startsAt && (
                        <NotifyWhenFreeButton window={heldWindow} />
                      )}
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
