"use client";

import {
  HELD_BY_SOMEONE_ELSE,
  NotifyWhenFreeButton,
  type BackupWindowRequest,
} from "@/components/booking/NotifyWhenFreeButton";
import { CalendarIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ClockIcon,
  CheckCircle2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { BookingSteps } from "@/components/booking/BookingSteps";
import { BookingSummary } from "@/components/booking/BookingSummary";
import { BookingCalendarLoadingGrid } from "@/components/booking/BookingCalendarLoadingGrid";
import {
  sameBookingWindow,
  isCurrentBookingWindow,
} from "@/lib/booking/selection";
import { cn } from "@/utils/tailwind";
import { formatInTimeZone } from "date-fns-tz";
import { useSession } from "@/lib/auth-client";
import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";
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
  renderCalendar: () => JSX.Element[];
  slotTimings: TIntervalTiming[];
  selectedSlot: TIntervalTiming | null;
  setSelectedSlot: (slot: TIntervalTiming | null) => void;
  timezone: string;
  onRefreshSlots?: () => void;
  slotsLoading?: boolean;
  slotsError?: boolean;
  calendarLoading?: boolean;
  calendarError?: boolean;
  initialPlanId?: string | null;
  bookingRequest?: number;
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
  slotsLoading = false,
  slotsError = false,
  calendarLoading = false,
  calendarError = false,
  initialPlanId,
  bookingRequest = 0,
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  // Track the active plan by id so plans that share a duration (e.g. two
  // 1-hour consultations) remain independently selectable and bookable.
  const [activeConsultationOption, setActiveConsultationOption] =
    useState<string>(
      consultationOptions.some((o) => o.id === initialPlanId)
        ? initialPlanId!
        : (consultationOptions[0]?.id ?? ""),
    );
  const [dialogOpen, setDialogOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousBookingRequest = useRef(bookingRequest);
  const [step, setStep] = useState(0);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [pendingIntent, setPendingIntent] =
    useState<ReturnType<typeof consumePurchaseIntent>>(null);
  useEffect(() => {
    if (bookingRequest > previousBookingRequest.current) {
      returnFocus.current = document.activeElement as HTMLElement;
      setStep(0);
      setDialogOpen(true);
    }
    previousBookingRequest.current = bookingRequest;
  }, [bookingRequest]);
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

  // Restore the plan and day before matching against that day's fetched windows.
  const purchaseIntentConsumedRef = useRef(false);
  useEffect(() => {
    if (purchaseIntentConsumedRef.current || !session?.user?.id) return;
    purchaseIntentConsumedRef.current = true;
    const intent = consumePurchaseIntent(consultantDetails.id);
    if (
      !intent ||
      !consultationOptions.some((o) => o.id === intent.consultationPlanId)
    )
      return;
    const date = new Date(intent.slot.startsAt);
    if (!Number.isFinite(date.getTime())) return;
    setActiveConsultationOption(intent.consultationPlanId);
    setSelectedDate(date);
    setCurrentDate(new Date(date.getFullYear(), date.getMonth(), 1));
    setPendingIntent(intent);
    setDialogOpen(true);
    setStep(1);
  }, [
    session?.user?.id,
    consultantDetails.id,
    consultationOptions,
    setSelectedDate,
    setCurrentDate,
  ]);

  useEffect(() => {
    if (
      !pendingIntent ||
      slotsLoading ||
      slotsError ||
      !selectedDate ||
      !timezone
    )
      return;
    if (
      activeConsultationOption !== pendingIntent.consultationPlanId ||
      formatInTimeZone(selectedDate, timezone, "yyyy-MM-dd") !==
        formatInTimeZone(
          new Date(pendingIntent.slot.startsAt),
          timezone,
          "yyyy-MM-dd",
        )
    )
      return;
    const match = availableSlots.find(
      (slot) =>
        sameBookingWindow(slot, pendingIntent.slot) &&
        isCurrentBookingWindow(slot, Date.now(), MINIMUM_BOOKING_LEAD_TIME_MS),
    );
    setPendingIntent(null);
    if (match) {
      setSelectedSlot(match);
      setStep(2);
      toast({
        title: "Welcome back",
        description: "Your previously selected time slot was restored.",
      });
    } else {
      setSelectionNotice(
        "Your previous time is no longer available. Please choose another.",
      );
    }
  }, [
    pendingIntent,
    slotsLoading,
    slotsError,
    selectedDate,
    timezone,
    availableSlots,
    activeConsultationOption,
    setSelectedSlot,
    toast,
  ]);

  // A refreshed window can become booked or allocated while the dialog is open.
  // Never retain yesterday's data during a fetch or submit a removed window.
  const currentSlot =
    selectedSlot && !slotsLoading && !slotsError
      ? availableSlots.find(
          (slot) =>
            sameBookingWindow(slot, selectedSlot) &&
            isCurrentBookingWindow(
              slot,
              Date.now(),
              MINIMUM_BOOKING_LEAD_TIME_MS,
            ),
        )
      : undefined;
  // Use the live window's allocation, not the selection snapshot: a refresh
  // must switch an INSTANT slot to approval before the next user interaction.
  const cta = consultationCtaFor(
    consultantDetails.bookingMode ?? "INSTANT",
    currentSlot?.isAllocated ?? false,
  );
  const paused =
    cta.action === "request" && consultantDetails.acceptingRequests === false;
  useEffect(() => {
    if (!selectedSlot || slotsLoading || slotsError || pendingIntent) return;
    if (!currentSlot) {
      setSelectedSlot(null);
      setStep(1);
      setSelectionNotice(
        "Availability changed. Please choose an available time.",
      );
    } else if (
      currentSlot.isAllocated !== selectedSlot.isAllocated ||
      currentSlot.bookingStatus !== selectedSlot.bookingStatus
    ) {
      setSelectedSlot(currentSlot);
    }
  }, [
    currentSlot,
    selectedSlot,
    slotsLoading,
    slotsError,
    pendingIntent,
    setSelectedSlot,
  ]);

  const choosePlan = (id: string) => {
    setActiveConsultationOption(id);
    setSelectedSlot(null);
    setHeldWindow(null);
    setStep(0);
    setSelectionNotice("");
  };

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
      setDialogOpen(false);
    } catch (error) {
      console.error("Error requesting approval:", error);
      if (
        error instanceof ApiResponseError &&
        error.code &&
        HELD_BY_SOMEONE_ELSE.has(error.code)
      ) {
        setHeldWindow({
          consultantProfileId: consultantDetails.id,
          windowStart: selectedSlot.startsAt,
          windowEnd: selectedSlot.endsAt,
          planKind: "CONSULTATION",
          planId: activePlan.id,
        });
      }
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
    setStep(0);
    setCurrentDate(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  if (consultationOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-muted-foreground">
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
        <h3 className="text-2xl font-medium tracking-tight text-foreground">
          Consultee Access Required
        </h3>
        <p className="text-zinc-500">
          To book consultations, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Tabs value={activeConsultationOption} onValueChange={choosePlan}>
        <TabsList
          className="pricing-segments w-full"
          aria-label="Consultation plan"
        >
          {consultationOptions.map((option) => (
            <TabsTrigger key={option.id} value={option.id}>
              {option.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {activePlanOption && (
        <>
          <div>
            <h3 className="text-lg font-semibold">{activePlanOption.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {activePlanOption.description}
            </p>
          </div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight break-all">
              {formatPrice(activePlanOption.price)}
            </span>
            <span className="text-sm text-muted-foreground">/ session</span>
          </div>
          {!!activePlanOption.features?.length && (
            <ul className="space-y-3 text-sm">
              {activePlanOption.features.map((feature, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                  {feature}
                </li>
              ))}
            </ul>
          )}
          <Button
            className="h-12 w-full rounded-xl"
            onClick={() => {
              returnFocus.current = document.activeElement as HTMLElement;
              setStep(0);
              setDialogOpen(true);
            }}
          >
            Choose a time
          </Button>
          <Button asChild variant="outline" className="h-11 w-full rounded-xl">
            <Link
              href={`/explore/programs/plans/consultations/${activePlanOption.id}`}
            >
              Read plan details
            </Link>
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogContent
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                returnFocus.current?.focus();
              }}
              overlayClassName="z-[1100]"
              className="booking-dialog z-[1101] sm:max-w-3xl"
            >
              <DialogHeader className="p-6 pr-12">
                <DialogTitle className="text-2xl font-semibold">
                  Book your consultation
                </DialogTitle>
                <DialogDescription>
                  {activePlanOption.description || activePlanOption.title} ·{" "}
                  {activePlanOption.duration}
                </DialogDescription>
              </DialogHeader>
              <BookingSteps steps={["Date", "Time", "Review"]} current={step} />
              {selectionNotice && (
                <p
                  role="status"
                  className="mx-6 mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
                >
                  {selectionNotice}
                </p>
              )}
              {step < 2 ? (
                <div className="grid gap-6 p-4 sm:p-6 md:grid-cols-2">
                  <section
                    className={cn(step !== 0 && "hidden md:block")}
                    aria-label="Choose a date"
                  >
                    <h3 className="mb-4 flex items-center gap-2 font-semibold">
                      <CalendarIcon className="h-4 w-4" />
                      Choose a date
                    </h3>
                    <div
                      className="calendar-surface p-3 sm:p-4"
                      aria-busy={calendarLoading}
                    >
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {currentDate.toLocaleString("default", {
                            month: "long",
                            year: "numeric",
                          })}
                        </span>
                        <div className="flex items-center">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={handleBookNowClick}
                          >
                            Today
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label="Previous month"
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
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label="Next month"
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
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="mb-2 grid grid-cols-7 text-center text-xs text-muted-foreground">
                        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(
                          (day) => (
                            <span key={day}>{day}</span>
                          ),
                        )}
                      </div>
                      {calendarLoading ? (
                        <BookingCalendarLoadingGrid month={currentDate} />
                      ) : (
                        <div className="grid grid-cols-7 gap-1">
                          {renderCalendar()}
                        </div>
                      )}
                    </div>
                    {calendarLoading ? (
                      <p
                        role="status"
                        className="mt-3 text-xs text-muted-foreground"
                      >
                        Checking available dates…
                      </p>
                    ) : calendarError ? (
                      <p
                        role="status"
                        className="mt-3 text-xs text-muted-foreground"
                      >
                        Couldn’t check available dates. Choose a day to check
                        its times.
                      </p>
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Outlined days have available times. Times shown in{" "}
                        {timezone}.
                      </p>
                    )}
                  </section>
                  <section
                    className={cn(step !== 1 && "hidden md:block")}
                    aria-label="Choose a time"
                  >
                    <div className="mb-4 flex items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 font-semibold">
                        <ClockIcon className="h-4 w-4" />
                        Choose a time
                      </h3>
                      {onRefreshSlots && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Refresh slot availability"
                          disabled={isRefreshing}
                          onClick={async () => {
                            setIsRefreshing(true);
                            try {
                              await onRefreshSlots();
                            } finally {
                              setIsRefreshing(false);
                            }
                          }}
                        >
                          <RefreshCw
                            className={cn(
                              "h-4 w-4",
                              isRefreshing && "animate-spin",
                            )}
                          />
                        </Button>
                      )}
                    </div>
                    {selectedDate && (
                      <p className="mb-3 text-sm text-muted-foreground">
                        {formatInTimeZone(
                          selectedDate,
                          timezone,
                          "EEEE, MMMM d",
                        )}
                      </p>
                    )}
                    <div
                      className="max-h-80 space-y-2 overflow-y-auto"
                      aria-busy={slotsLoading}
                    >
                      {slotsLoading ? (
                        <p
                          role="status"
                          className="py-6 text-sm text-muted-foreground"
                        >
                          Checking available times…
                        </p>
                      ) : slotsError ? (
                        <p
                          role="alert"
                          className="py-6 text-sm text-destructive"
                        >
                          Couldn’t load times. Refresh to try again.
                        </p>
                      ) : (
                        <SlotList
                          slots={availableSlots}
                          selectedSlot={selectedSlot as SlotWithStatus | null}
                          onSelect={(slot) => {
                            setSelectedSlot(slot);
                            setSelectionNotice("");
                          }}
                          bookingMode={
                            consultantDetails.bookingMode ?? "INSTANT"
                          }
                        />
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="p-6">
                  <BookingSummary
                    title={
                      activePlanOption.description || activePlanOption.title
                    }
                    price={formatPrice(activePlanOption.price)}
                    unit="/ session"
                  >
                    {currentSlot && (
                      <p className="font-medium text-foreground">
                        {formatInTimeZone(
                          new Date(currentSlot.startsAt),
                          timezone,
                          "EEEE, MMMM d, yyyy",
                        )}
                        <br />
                        {formatInTimeZone(
                          new Date(currentSlot.startsAt),
                          timezone,
                          "h:mm a",
                        )}{" "}
                        –{" "}
                        {formatInTimeZone(
                          new Date(currentSlot.endsAt),
                          timezone,
                          "h:mm a",
                        )}
                      </p>
                    )}
                    <p>Time zone: {timezone}</p>
                    <p>{activePlanOption.duration} consultation</p>
                    {(paused || cta.hint) && (
                      <p>{paused ? CONSULTANT_PAUSED_HINT : cta.hint}</p>
                    )}
                  </BookingSummary>
                </div>
              )}
              <div className="booking-footer">
                <Button
                  variant="outline"
                  onClick={() =>
                    step === 0 ? setDialogOpen(false) : setStep(step - 1)
                  }
                >
                  {step === 0 ? "Cancel" : "Back"}
                </Button>
                {step === 0 ? (
                  <>
                    <Button
                      className="md:hidden"
                      disabled={
                        !selectedDate ||
                        calendarLoading ||
                        slotsLoading ||
                        slotsError
                      }
                      onClick={() => setStep(1)}
                    >
                      Choose time
                    </Button>
                    <Button
                      className="hidden md:inline-flex"
                      disabled={!currentSlot}
                      onClick={() => setStep(2)}
                    >
                      Review booking
                    </Button>
                  </>
                ) : step === 1 ? (
                  <Button disabled={!currentSlot} onClick={() => setStep(2)}>
                    Review booking
                  </Button>
                ) : (
                  <Button
                    disabled={!currentSlot || paused || isRequestingApproval}
                    onClick={() => {
                      if (
                        !currentSlot ||
                        !isCurrentBookingWindow(
                          currentSlot,
                          Date.now(),
                          MINIMUM_BOOKING_LEAD_TIME_MS,
                        )
                      ) {
                        setSelectedSlot(null);
                        setStep(1);
                        setSelectionNotice(
                          "This time is no longer available. Please choose another.",
                        );
                        return;
                      }
                      if (cta.action === "request")
                        void handleRequestForApproval();
                      else handleConsultationBooking(activePlanOption.id);
                    }}
                  >
                    {isRequestingApproval ? "Submitting…" : cta.label}
                  </Button>
                )}
                {heldWindow &&
                  heldWindow.windowStart === selectedSlot?.startsAt && (
                    <NotifyWhenFreeButton window={heldWindow} />
                  )}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
