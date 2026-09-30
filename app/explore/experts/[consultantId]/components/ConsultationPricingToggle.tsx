"use client";

import {
  HELD_BY_SOMEONE_ELSE,
  NotifyWhenFreeButton,
  type BackupWindowRequest,
} from "@/components/booking/NotifyWhenFreeButton";
import { BookingSteps } from "@/components/booking/BookingSteps";
import { BookingSummary } from "@/components/booking/BookingSummary";
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
import { ClockIcon, CheckCircle2, RefreshCw } from "lucide-react";
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
import {
  isCurrentBookingWindow,
  sameBookingWindow,
} from "@/lib/booking/selection";
import { formatInTimeZone } from "date-fns-tz";
import { cn } from "@/utils/tailwind";
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
  slotsLoading?: boolean;
  slotsError?: boolean;
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
    useState<string>(() =>
      initialPlanId && consultationOptions.some((o) => o.id === initialPlanId)
        ? initialPlanId
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
        <p className="text-muted-foreground">
          To book consultations, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Tabs value={activeConsultationOption} onValueChange={choosePlan}>
        <TabsList
          className="relative flex w-full p-1 bg-muted rounded-2xl border border-border h-auto"
          aria-label="Consultation plan"
        >
          {consultationOptions.map((option) => (
            <TabsTrigger
              key={option.id}
              value={option.id}
              className="flex-1 py-2 text-xs sm:text-sm font-medium rounded-xl data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm text-muted-foreground transition-all h-auto whitespace-nowrap"
            >
              {option.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {activePlanOption && (
        <>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {activePlanOption.title}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {activePlanOption.description}
            </p>
          </div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight text-foreground break-all">
              {formatPrice(activePlanOption.price)}
            </span>
            <span className="text-sm text-muted-foreground">/ session</span>
          </div>
          {!!activePlanOption.features?.length && (
            <ul className="space-y-2.5 text-sm text-foreground">
              {activePlanOption.features.map((feature, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  {feature}
                </li>
              ))}
            </ul>
          )}
          <Button
            className="h-12 w-full rounded-xl font-semibold"
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
              Read session details
            </Link>
          </Button>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogContent
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                returnFocus.current?.focus();
              }}
              className="z-[1101] max-h-[88vh] overflow-y-auto rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl sm:max-w-3xl"
            >
              <DialogHeader className="p-6 pr-12">
                <DialogTitle className="text-2xl font-semibold text-foreground">
                  {step === 2
                    ? "Review your consultation"
                    : `Book ${activePlanOption.title} Consultation`}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {activePlanOption.duration} consultation ·{" "}
                  {formatPrice(activePlanOption.price)}
                </DialogDescription>
              </DialogHeader>

              <BookingSteps
                steps={["Date", "Time", "Review"]}
                current={step}
              />

              {selectionNotice && (
                <p
                  role="alert"
                  className="mx-6 mt-4 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-foreground"
                >
                  {selectionNotice}
                </p>
              )}

              {step < 2 ? (
                <div className="grid gap-6 p-6 md:grid-cols-2">
                  <section
                    className={cn(step !== 0 && "hidden md:block")}
                    aria-label="Choose a date"
                  >
                    <h3 className="mb-4 flex items-center gap-2 font-semibold text-foreground">
                      <CalendarIcon className="h-4 w-4" />
                      Choose a date
                    </h3>
                    <div className="rounded-2xl border border-border bg-muted/40 p-4">
                      <div className="mb-4 flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">
                          {currentDate.toLocaleString("default", {
                            month: "long",
                            year: "numeric",
                          })}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={handleBookNowClick}
                          >
                            Today
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
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
                            &lt;
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
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
                            &gt;
                          </Button>
                        </div>
                      </div>
                      <div className="mb-2 grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
                        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(
                          (day) => (
                            <span key={day}>{day}</span>
                          ),
                        )}
                      </div>
                      <div className="grid grid-cols-7 gap-1">
                        {renderCalendar(selectedDuration)}
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Outlined days have available times for a{" "}
                      {selectedDuration}-hour session. Times shown in {timezone}.
                    </p>
                  </section>

                  <section
                    className={cn(step !== 1 && "hidden md:block")}
                    aria-label="Choose a time"
                  >
                    <div className="mb-4 flex items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 font-semibold text-foreground">
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
                          Couldn&apos;t load times. Refresh to try again.
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

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-6 py-4">
                <Button
                  variant="outline"
                  onClick={() =>
                    step === 0 ? setDialogOpen(false) : setStep(step - 1)
                  }
                >
                  {step === 0 ? "Cancel" : "Back"}
                </Button>
                <div className="flex items-center gap-2">
                  {step === 0 ? (
                    <>
                      <Button
                        className="md:hidden"
                        disabled={!selectedDate || slotsLoading || slotsError}
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
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
