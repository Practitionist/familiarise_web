"use client";

import {
  HELD_BY_SOMEONE_ELSE,
  NotifyWhenFreeButton,
  type BackupWindowRequest,
} from "@/components/booking/NotifyWhenFreeButton";
import { BookingSteps } from "@/components/booking/BookingSteps";
import { BookingSummary } from "@/components/booking/BookingSummary";
import { CalendarIcon } from "@/assets/icons";
import { PlanBrochureDownload } from "@/components/plans/PlanBrochureDownload";
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
import { reportSentryError } from "@/lib/observability/report";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PricingOption } from "../defaults";
import { TIntervalTiming } from "@/types/slots";
import { buildDurationWindowStarts } from "../day-state";
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
  selectedPlanId?: string;
  onSelectPlanId?: (planId: string) => void;
  bookingRequest?: number;
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

function resolveInitialConsultationOption(
  initialPlanId: string | null | undefined,
  options: readonly PricingOption[],
): string {
  if (initialPlanId && options.some((o) => o.id === initialPlanId)) {
    return initialPlanId;
  }
  return options[0]?.id ?? "";
}

function buildAvailableSlots(
  slotTimings: readonly TIntervalTiming[] | undefined,
  selectedDuration: number,
  timezone: string,
  selectedDate: Date | null,
): SlotWithStatus[] {
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

  const brokenDownSlots = buildDurationWindowStarts(
    slotsWithAllocation,
    selectedDuration,
  );

  const now = Date.now();
  return brokenDownSlots.map((slot) => {
    const startDate = new Date(slot.startsAt);
    const endDate = new Date(slot.endsAt);
    return {
      ...slot,
      localStartTime: formatInTimeZone(startDate, timezone, "h:mm a"),
      localEndTime: formatInTimeZone(endDate, timezone, "h:mm a"),
      _isPast: startDate.getTime() < now + MINIMUM_BOOKING_LEAD_TIME_MS,
    };
  });
}

function hasSlotMetadataDrifted(
  currentSlot: SlotWithStatus,
  selectedSlot: TIntervalTiming,
): boolean {
  return (
    currentSlot.isAllocated !== selectedSlot.isAllocated ||
    currentSlot.bookingStatus !== selectedSlot.bookingStatus ||
    currentSlot.availabilityWindowId !== selectedSlot.availabilityWindowId ||
    currentSlot.type !== selectedSlot.type
  );
}

function isNonConsulteeRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return ["consultant", "staff"].includes(role.toLowerCase());
}

function buildApprovalRequestBody(
  consultantProfileId: string,
  planId: string,
  slot: TIntervalTiming,
) {
  const requestBody: {
    consultantProfileId: string;
    startsAt: string;
    endsAt: string;
    consultationPlanId: string;
    availabilityWindowWeeklyId?: string;
    availabilityWindowCustomId?: string;
  } = {
    consultantProfileId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    consultationPlanId: planId,
  };

  if (slot.type === "WEEKLY") {
    requestBody.availabilityWindowWeeklyId = slot.availabilityWindowId;
  } else {
    requestBody.availabilityWindowCustomId = slot.availabilityWindowId;
  }

  return requestBody;
}

function SlotSectionContent({
  slotsLoading,
  slotsError,
  availableSlots,
  selectedSlot,
  bookingMode,
  onSelectSlot,
}: Readonly<{
  slotsLoading: boolean;
  slotsError: boolean;
  availableSlots: SlotWithStatus[];
  selectedSlot: TIntervalTiming | null;
  bookingMode: BookingMode;
  onSelectSlot: (slot: SlotWithStatus) => void;
}>) {
  if (slotsLoading) {
    return (
      <output className="block py-6 text-sm text-muted-foreground">
        Checking available times…
      </output>
    );
  }

  if (slotsError) {
    return (
      <p role="alert" className="py-6 text-sm text-destructive">
        Couldn&apos;t load times. Refresh to try again.
      </p>
    );
  }

  return (
    <SlotList
      slots={availableSlots}
      selectedSlot={selectedSlot as SlotWithStatus | null}
      onSelect={onSelectSlot}
      bookingMode={bookingMode}
    />
  );
}

function ConsultationDateAndTimePicker({
  step,
  currentDate,
  setCurrentDate,
  selectedDate,
  selectedDuration,
  timezone,
  renderCalendar,
  onBookToday,
  onRefreshSlots,
  isRefreshing,
  setIsRefreshing,
  slotsLoading,
  slotsError,
  availableSlots,
  selectedSlot,
  bookingMode,
  onSelectSlot,
}: Readonly<{
  step: number;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  selectedDate: Date | null;
  selectedDuration: number;
  timezone: string;
  renderCalendar: (durationInHours: number) => JSX.Element[];
  onBookToday: () => void;
  onRefreshSlots?: () => void;
  isRefreshing: boolean;
  setIsRefreshing: (value: boolean) => void;
  slotsLoading: boolean;
  slotsError: boolean;
  availableSlots: SlotWithStatus[];
  selectedSlot: TIntervalTiming | null;
  bookingMode: BookingMode;
  onSelectSlot: (slot: SlotWithStatus) => void;
}>) {
  return (
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
                onClick={onBookToday}
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
            {WEEKDAY_LABELS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {renderCalendar(selectedDuration)}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Outlined days have available times for a {selectedDuration}-hour
          session. Times shown in {timezone}.
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
                className={cn("h-4 w-4", isRefreshing && "animate-spin")}
              />
            </Button>
          )}
        </div>
        {selectedDate && (
          <p className="mb-3 text-sm text-muted-foreground">
            {formatInTimeZone(selectedDate, timezone, "EEEE, MMMM d")}
          </p>
        )}
        <div
          className="max-h-80 space-y-2 overflow-y-auto"
          aria-busy={slotsLoading}
        >
          <SlotSectionContent
            slotsLoading={slotsLoading}
            slotsError={slotsError}
            availableSlots={availableSlots}
            selectedSlot={selectedSlot}
            bookingMode={bookingMode}
            onSelectSlot={onSelectSlot}
          />
        </div>
      </section>
    </div>
  );
}

function ConsultationReviewStep({
  activePlanOption,
  formattedPrice,
  currentSlot,
  timezone,
  paused,
  ctaHint,
}: Readonly<{
  activePlanOption: PricingOption;
  formattedPrice: string;
  currentSlot: SlotWithStatus | undefined;
  timezone: string;
  paused: boolean;
  ctaHint?: string | null;
}>) {
  return (
    <div className="p-6">
      <BookingSummary
        title={activePlanOption.description || activePlanOption.title}
        price={formattedPrice}
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
            {formatInTimeZone(new Date(currentSlot.endsAt), timezone, "h:mm a")}
          </p>
        )}
        <p>Time zone: {timezone}</p>
        <p>{activePlanOption.duration} consultation</p>
        {(paused || ctaHint) && (
          <p>{paused ? CONSULTANT_PAUSED_HINT : ctaHint}</p>
        )}
      </BookingSummary>
    </div>
  );
}

function ConsultationDialogFooterActions({
  step,
  selectedDate,
  slotsLoading,
  slotsError,
  currentSlot,
  paused,
  isRequestingApproval,
  ctaLabel,
  setStep,
  onConfirmStepTwo,
}: Readonly<{
  step: number;
  selectedDate: Date | null;
  slotsLoading: boolean;
  slotsError: boolean;
  currentSlot: SlotWithStatus | undefined;
  paused: boolean;
  isRequestingApproval: boolean;
  ctaLabel: string;
  setStep: (step: number) => void;
  onConfirmStepTwo: () => void;
}>) {
  if (step === 0) {
    return (
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
    );
  }

  if (step === 1) {
    return (
      <Button disabled={!currentSlot} onClick={() => setStep(2)}>
        Review booking
      </Button>
    );
  }

  return (
    <Button
      disabled={!currentSlot || paused || isRequestingApproval}
      onClick={onConfirmStepTwo}
    >
      {isRequestingApproval ? "Submitting…" : ctaLabel}
    </Button>
  );
}

function useRestoreConsultationIntent({
  userId,
  consultantId,
  consultationOptions,
  activeConsultationOption,
  setActiveConsultationOption,
  selectedDate,
  setSelectedDate,
  setCurrentDate,
  timezone,
  slotsLoading,
  slotsError,
  availableSlots,
  setSelectedSlot,
  setDialogOpen,
  setStep,
  setSelectionNotice,
  toast,
}: {
  userId: string | undefined;
  consultantId: string;
  consultationOptions: readonly PricingOption[];
  activeConsultationOption: string;
  setActiveConsultationOption: (id: string) => void;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  setCurrentDate: (date: Date) => void;
  timezone: string;
  slotsLoading: boolean;
  slotsError: boolean;
  availableSlots: readonly SlotWithStatus[];
  setSelectedSlot: (slot: TIntervalTiming | null) => void;
  setDialogOpen: (open: boolean) => void;
  setStep: (step: number) => void;
  setSelectionNotice: (notice: string) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const purchaseIntentConsumedRef = useRef(false);
  const [pendingIntent, setPendingIntent] =
    useState<ReturnType<typeof consumePurchaseIntent>>(null);

  useEffect(() => {
    if (purchaseIntentConsumedRef.current || !userId) return;
    purchaseIntentConsumedRef.current = true;
    const intent = consumePurchaseIntent(consultantId);
    if (
      !intent ||
      !consultationOptions.some((o) => o.id === intent.consultationPlanId)
    ) {
      return;
    }
    const date = new Date(intent.slot.startsAt);
    if (!Number.isFinite(date.getTime())) return;
    setActiveConsultationOption(intent.consultationPlanId);
    setSelectedDate(date);
    setCurrentDate(new Date(date.getFullYear(), date.getMonth(), 1));
    setPendingIntent(intent);
    setDialogOpen(true);
    setStep(1);
  }, [
    userId,
    consultantId,
    consultationOptions,
    setActiveConsultationOption,
    setSelectedDate,
    setCurrentDate,
    setDialogOpen,
    setStep,
  ]);

  useEffect(() => {
    if (
      !pendingIntent ||
      slotsLoading ||
      slotsError ||
      !selectedDate ||
      !timezone
    ) {
      return;
    }
    const samePlan =
      activeConsultationOption === pendingIntent.consultationPlanId;
    const sameDay =
      formatInTimeZone(selectedDate, timezone, "yyyy-MM-dd") ===
      formatInTimeZone(
        new Date(pendingIntent.slot.startsAt),
        timezone,
        "yyyy-MM-dd",
      );
    if (!samePlan || !sameDay) return;

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
    setStep,
    setSelectionNotice,
    toast,
  ]);

  return pendingIntent;
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
  selectedPlanId,
  onSelectPlanId,
  bookingRequest = 0,
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();

  const [internalConsultationOption, setInternalConsultationOption] =
    useState<string>(() =>
      resolveInitialConsultationOption(initialPlanId, consultationOptions),
    );
  const activeConsultationOption =
    selectedPlanId && consultationOptions.some((o) => o.id === selectedPlanId)
      ? selectedPlanId
      : internalConsultationOption;
  const setActiveConsultationOption = useCallback(
    (id: string) => {
      setInternalConsultationOption(id);
      onSelectPlanId?.(id);
    },
    [onSelectPlanId],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousBookingRequest = useRef(bookingRequest);
  const [step, setStep] = useState(0);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);
  const [heldWindow, setHeldWindow] = useState<BackupWindowRequest | null>(
    null,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (bookingRequest > previousBookingRequest.current) {
      returnFocus.current = document.activeElement as HTMLElement;
      setStep(0);
      setDialogOpen(true);
    }
    previousBookingRequest.current = bookingRequest;
  }, [bookingRequest]);

  const activePlanOption = useMemo(
    () =>
      consultationOptions.find((opt) => opt.id === activeConsultationOption),
    [activeConsultationOption, consultationOptions],
  );

  const selectedDuration = activePlanOption?.durationInHours ?? 1;

  const availableSlots = useMemo(
    () =>
      buildAvailableSlots(
        slotTimings,
        selectedDuration,
        timezone,
        selectedDate,
      ),
    [slotTimings, selectedDuration, timezone, selectedDate],
  );

  const pendingIntent = useRestoreConsultationIntent({
    userId: session?.user?.id,
    consultantId: consultantDetails.id,
    consultationOptions,
    activeConsultationOption,
    setActiveConsultationOption,
    selectedDate,
    setSelectedDate,
    setCurrentDate,
    timezone,
    slotsLoading,
    slotsError,
    availableSlots,
    setSelectedSlot,
    setDialogOpen,
    setStep,
    setSelectionNotice,
    toast,
  });

  const currentSlot = useMemo(() => {
    if (!selectedSlot || slotsLoading || slotsError) return undefined;
    return availableSlots.find(
      (slot) =>
        sameBookingWindow(slot, selectedSlot) &&
        isCurrentBookingWindow(slot, Date.now(), MINIMUM_BOOKING_LEAD_TIME_MS),
    );
  }, [selectedSlot, slotsLoading, slotsError, availableSlots]);

  const bookingMode = consultantDetails.bookingMode ?? "INSTANT";
  const cta = consultationCtaFor(bookingMode, currentSlot?.isAllocated ?? false);
  const paused =
    cta.action === "request" && consultantDetails.acceptingRequests === false;

  // The plan can change from outside this component (PlanDetailsSnapshot, the
  // ?plan= URL effect) without going through choosePlan. A slot picked for the
  // old plan's duration must never survive into the new plan's checkout.
  const previousPlanIdRef = useRef(activeConsultationOption);
  useEffect(() => {
    if (previousPlanIdRef.current === activeConsultationOption) return;
    previousPlanIdRef.current = activeConsultationOption;
    // A restored purchase intent sets the plan and its own step/slot flow.
    if (pendingIntent) return;
    setSelectedSlot(null);
    setHeldWindow(null);
    setStep(0);
    setSelectionNotice("");
  }, [activeConsultationOption, pendingIntent, setSelectedSlot]);

  const driftPlanIdRef = useRef(activeConsultationOption);
  useEffect(() => {
    // On the commit where the plan changed, the reset above owns the slot;
    // don't also flag it as an availability change.
    if (driftPlanIdRef.current !== activeConsultationOption) {
      driftPlanIdRef.current = activeConsultationOption;
      return;
    }
    if (!selectedSlot || slotsLoading || slotsError || pendingIntent) return;
    if (!currentSlot) {
      setSelectedSlot(null);
      setStep(1);
      setSelectionNotice(
        "Availability changed. Please choose an available time.",
      );
    } else if (hasSlotMetadataDrifted(currentSlot, selectedSlot)) {
      setSelectedSlot(currentSlot);
    }
  }, [
    activeConsultationOption,
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
          type: selectedSlot.type,
          availabilityWindowId: selectedSlot.availabilityWindowId,
        },
      });
      const callbackUrl = `${window.location.pathname}${window.location.search}`;
      router.push(
        `/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      );
      return;
    }

    const activePlan = consultantDetails.consultationPlans.find(
      (plan) => plan.id === activeConsultationOption,
    );

    if (!activePlan) {
      toast({ title: "Invalid consultation plan", variant: "destructive" });
      return;
    }

    setIsRequestingApproval(true);
    try {
      const requestBody = buildApprovalRequestBody(
        consultantDetails.id,
        activePlan.id,
        selectedSlot,
      );
      const response = await fetch("/api/scheduling/request-for-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const isHeldConflict =
        error instanceof ApiResponseError &&
        Boolean(error.code && HELD_BY_SOMEONE_ELSE.has(error.code));
      if (isHeldConflict) {
        setHeldWindow({
          consultantProfileId: consultantDetails.id,
          windowStart: selectedSlot.startsAt,
          windowEnd: selectedSlot.endsAt,
          planKind: "CONSULTATION",
          planId: activePlan.id,
        });
      } else {
        reportSentryError(error, {
          subsystem: "booking",
          op: "request_for_approval",
          expected: false,
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

  const handleConfirmStepTwo = () => {
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
    if (cta.action === "request") {
      void handleRequestForApproval();
    } else if (activePlanOption) {
      handleConsultationBooking(activePlanOption.id);
    }
  };

  if (consultationOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-muted-foreground">
        <p>No consultation plans available at the moment.</p>
      </div>
    );
  }

  if (isNonConsulteeRole(session?.user?.role)) {
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
              {activePlanOption.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
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
          <PlanBrochureDownload
            planId={activePlanOption.id}
            planType="consultations"
            className="w-full justify-center"
          />

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
                <ConsultationDateAndTimePicker
                  step={step}
                  currentDate={currentDate}
                  setCurrentDate={setCurrentDate}
                  selectedDate={selectedDate}
                  selectedDuration={selectedDuration}
                  timezone={timezone}
                  renderCalendar={renderCalendar}
                  onBookToday={handleBookNowClick}
                  onRefreshSlots={onRefreshSlots}
                  isRefreshing={isRefreshing}
                  setIsRefreshing={setIsRefreshing}
                  slotsLoading={slotsLoading}
                  slotsError={slotsError}
                  availableSlots={availableSlots}
                  selectedSlot={selectedSlot}
                  bookingMode={bookingMode}
                  onSelectSlot={(slot) => {
                    setSelectedSlot(slot);
                    setSelectionNotice("");
                  }}
                />
              ) : (
                <ConsultationReviewStep
                  activePlanOption={activePlanOption}
                  formattedPrice={formatPrice(activePlanOption.price)}
                  currentSlot={currentSlot}
                  timezone={timezone}
                  paused={paused}
                  ctaHint={cta.hint}
                />
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
                  <ConsultationDialogFooterActions
                    step={step}
                    selectedDate={selectedDate}
                    slotsLoading={slotsLoading}
                    slotsError={slotsError}
                    currentSlot={currentSlot}
                    paused={paused}
                    isRequestingApproval={isRequestingApproval}
                    ctaLabel={cta.label}
                    setStep={setStep}
                    onConfirmStepTwo={handleConfirmStepTwo}
                  />
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
