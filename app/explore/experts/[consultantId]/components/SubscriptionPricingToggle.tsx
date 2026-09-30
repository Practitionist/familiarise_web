"use client";

import * as Sentry from "@sentry/nextjs";
import { BookingSteps } from "@/components/booking/BookingSteps";
import { BookingSummary } from "@/components/booking/BookingSummary";
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
import { CalendarIcon, CheckCircle2, Gift, BookOpen } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import Link from "next/link";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { PricingOption } from "../defaults";
import { useToast } from "@/hooks/use-toast";
import { format, isSameDay, startOfDay } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { firstCycleWindow } from "@/lib/booking/entitlement";
import { formatCurrencyAmount } from "@/utils/formatting";
import { cn } from "@/utils/tailwind";
import { TrialBookingModal } from "./TrialBookingModal";

interface SubscriptionContentItem {
  id?: string;
  title: string;
  description?: string | null;
  order?: number;
  hoursAllotted?: number | null;
  contentType?: string | null;
  sectionLabel?: string | null;
  outcomes?: string[];
}

interface SubscriptionPlanDetails {
  id: string;
  title: string;
  subtitle?: string | null;
  durationInMonths: number;
  trialEnabled?: boolean;
  trialDurationMinutes?: number | null;
  trialPriceInPaise?: number | null;
  priceCurrency?: string | null;
  subscriptionContents?: SubscriptionContentItem[] | null;
  targetAudience?: string[];
  whatsIncluded?: string[];
  faqs?: { id?: string; question: string; answer: string }[];
}

interface ConsultantDetailsForSubscription {
  id: string;
  subscriptionPlans?: SubscriptionPlanDetails[];
  user?: {
    name?: string | null;
  };
}

interface SubscriptionPricingToggleProps {
  subscriptionOptions: PricingOption[];
  consultantDetails: ConsultantDetailsForSubscription;
  handleSubscriptionBooking: (
    option: PricingOption,
    schedulingPeriod: { startDate: Date; endDate: Date },
  ) => void;
  timezone: string;
  autoOpenTrial?: boolean;
  initialPlanId?: string | null;
  bookingRequest?: number;
}

interface TrialEligibilityState {
  isEligible: boolean;
  reason?: string;
  isLoading: boolean;
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const EMPTY_CELL_OFFSETS = [0, 1, 2, 3, 4, 5] as const;

function getStartCalendarCellClass(
  isSelected: boolean,
  isPast: boolean,
): string {
  if (isSelected) {
    return "bg-primary font-semibold text-primary-foreground shadow-sm";
  }
  if (isPast) {
    return "opacity-40 text-muted-foreground";
  }
  return "text-foreground hover:bg-muted font-medium";
}

function getTrialButtonLabel(
  isLoading: boolean,
  isEligible: boolean,
  trialCtaPrice: string,
  trialDurationMinutes: number,
): string {
  if (isLoading) {
    return "Checking trial eligibility…";
  }
  if (isEligible) {
    return `Request a trial (${trialCtaPrice}, ${trialDurationMinutes} min)`;
  }
  return "Trial already requested";
}

async function fetchTrialEligibility(
  userId: string,
  consultantProfileId: string | undefined,
  subscriptionPlanId: string,
): Promise<TrialEligibilityState> {
  try {
    const profileResponse = await fetch(
      `/api/profiles/consultee?userId=${userId}`,
    );
    if (!profileResponse.ok) {
      return {
        isEligible: false,
        reason: "Could not verify profile",
        isLoading: false,
      };
    }
    const { data: consulteeProfile } = await profileResponse.json();
    if (!consulteeProfile?.id) {
      return { isEligible: true, isLoading: false };
    }

    const eligibilityResponse = await fetch(
      `/api/trials/check-eligibility?consulteeProfileId=${consulteeProfile.id}&consultantProfileId=${consultantProfileId}&subscriptionPlanId=${subscriptionPlanId}`,
    );
    if (!eligibilityResponse.ok) {
      return { isEligible: true, isLoading: false };
    }

    const { data } = await eligibilityResponse.json();
    return {
      isEligible: data.isEligible,
      reason: data.reason,
      isLoading: false,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "client" } },
    );
    console.error("Error checking trial eligibility:", error);
    return { isEligible: true, isLoading: false };
  }
}

function useTrialEligibility(
  userId: string | undefined,
  consultantProfileId: string | undefined,
  selectedPlanDetails: SubscriptionPlanDetails | null | undefined,
): TrialEligibilityState {
  const [trialEligibility, setTrialEligibility] =
    useState<TrialEligibilityState>({
      isEligible: true,
      isLoading: false,
    });

  useEffect(() => {
    if (
      !userId ||
      !selectedPlanDetails?.id ||
      !selectedPlanDetails?.trialEnabled
    ) {
      return;
    }

    let cancelled = false;
    setTrialEligibility((prev) => ({ ...prev, isLoading: true }));

    void fetchTrialEligibility(
      userId,
      consultantProfileId,
      selectedPlanDetails.id,
    ).then((nextState) => {
      if (!cancelled) {
        setTrialEligibility(nextState);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    userId,
    selectedPlanDetails?.id,
    selectedPlanDetails?.trialEnabled,
    consultantProfileId,
  ]);

  return trialEligibility;
}

interface StartCalendarGridProps {
  calendarMonth: Date;
  schedulingStartDate: Date | null;
  onSelectDate: (date: Date) => void;
}

function StartCalendarGrid({
  calendarMonth,
  schedulingStartDate,
  onSelectDate,
}: Readonly<StartCalendarGridProps>) {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const adjustedFirstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const today = startOfDay(new Date());
  const dayNumbers = Array.from({ length: daysInMonth }, (_, idx) => idx + 1);

  return (
    <div className="grid grid-cols-7 gap-1">
      {EMPTY_CELL_OFFSETS.slice(0, adjustedFirstDay).map((offset) => (
        <div
          key={`empty-${year}-${month}-${offset}`}
          className="aspect-square w-full max-w-10"
        />
      ))}
      {dayNumbers.map((day) => {
        const date = new Date(year, month, day);
        const isPast = startOfDay(date) < today;
        const isSelected =
          schedulingStartDate !== null && isSameDay(date, schedulingStartDate);
        const isToday = isSameDay(date, today);

        return (
          <button
            key={day}
            type="button"
            disabled={isPast}
            aria-pressed={isSelected}
            aria-label={format(date, "MMMM d, yyyy")}
            className={cn(
              "relative flex aspect-square w-full max-w-10 items-center justify-center rounded-full text-sm transition-colors",
              getStartCalendarCellClass(isSelected, isPast),
            )}
            onClick={() => onSelectDate(date)}
          >
            {day}
            {isToday && (
              <span
                aria-hidden="true"
                className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

interface SubscriptionStartDateStepProps {
  consultantId: string;
  calendarMonth: Date;
  schedulingStartDate: Date | null;
  timezone: string;
  onChangeCalendarMonth: (month: Date) => void;
  onChangeSchedulingStartDate: (date: Date | null) => void;
}

function SubscriptionStartDateStep({
  consultantId,
  calendarMonth,
  schedulingStartDate,
  timezone,
  onChangeCalendarMonth,
  onChangeSchedulingStartDate,
}: Readonly<SubscriptionStartDateStepProps>) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-muted/40 p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground">
            {calendarMonth.toLocaleString("default", {
              month: "long",
              year: "numeric",
            })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const now = new Date();
                onChangeSchedulingStartDate(now);
                onChangeCalendarMonth(
                  new Date(now.getFullYear(), now.getMonth(), 1),
                );
              }}
            >
              Today
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Previous month"
              onClick={() =>
                onChangeCalendarMonth(
                  new Date(
                    calendarMonth.getFullYear(),
                    calendarMonth.getMonth() - 1,
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
                onChangeCalendarMonth(
                  new Date(
                    calendarMonth.getFullYear(),
                    calendarMonth.getMonth() + 1,
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
        <StartCalendarGrid
          calendarMonth={calendarMonth}
          schedulingStartDate={schedulingStartDate}
          onSelectDate={onChangeSchedulingStartDate}
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor={`subscription-start-${consultantId}`}
          className="flex items-center gap-2 text-sm font-medium text-foreground"
        >
          <CalendarIcon className="h-4 w-4" />
          Start date
        </label>
        <input
          id={`subscription-start-${consultantId}`}
          type="date"
          value={
            schedulingStartDate ? format(schedulingStartDate, "yyyy-MM-dd") : ""
          }
          min={format(new Date(), "yyyy-MM-dd")}
          className="h-11 w-full rounded-xl border border-input bg-background px-4 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => {
            const [y, m, d] = event.target.value.split("-").map(Number);
            if (event.target.value) {
              const next = new Date(y, m - 1, d);
              onChangeSchedulingStartDate(next);
              onChangeCalendarMonth(new Date(y, m - 1, 1));
            } else {
              onChangeSchedulingStartDate(null);
            }
          }}
        />
        <p className="text-xs text-muted-foreground">Time zone: {timezone}</p>
      </div>
    </div>
  );
}

interface SubscriptionOptionDetailsProps {
  selectedOption: PricingOption;
  selectedPlanDetails: SubscriptionPlanDetails | null | undefined;
  monthsCount: number;
  perMonthFormatted: string | null;
  trialCtaPrice: string;
  trialEligibility: TrialEligibilityState;
  onChoosePlan: () => void;
  onRequestTrial: () => void;
}

function SubscriptionOptionDetails({
  selectedOption,
  selectedPlanDetails,
  monthsCount,
  perMonthFormatted,
  trialCtaPrice,
  trialEligibility,
  onChoosePlan,
  onRequestTrial,
}: Readonly<SubscriptionOptionDetailsProps>) {
  return (
    <>
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          {selectedOption.title}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {selectedOption.description}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-4xl font-semibold tracking-tight text-foreground break-all">
            {formatCurrencyAmount(
              selectedOption.price,
              selectedOption.priceCurrency || "INR",
            )}
          </span>
          <span className="text-sm text-muted-foreground">
            / {monthsCount > 1 ? `${monthsCount} months total` : "month"}
          </span>
        </div>
        {monthsCount > 1 && perMonthFormatted && (
          <p className="text-xs font-medium text-muted-foreground">
            Equivalent to {perMonthFormatted} / month
          </p>
        )}
      </div>

      {!!selectedOption.features?.length && (
        <ul className="space-y-2.5 text-sm text-foreground">
          {selectedOption.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              {feature}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2.5">
        <Button
          className="h-12 w-full rounded-xl font-semibold"
          onClick={onChoosePlan}
        >
          Choose a start date
        </Button>

        {selectedPlanDetails?.trialEnabled && (
          <>
            <Button
              variant="outline"
              className="h-auto min-h-11 w-full whitespace-normal rounded-xl"
              disabled={
                !trialEligibility.isEligible || trialEligibility.isLoading
              }
              onClick={onRequestTrial}
            >
              <Gift className="mr-2 h-4 w-4 shrink-0 text-emerald-600" />
              {getTrialButtonLabel(
                trialEligibility.isLoading,
                trialEligibility.isEligible,
                trialCtaPrice,
                selectedPlanDetails.trialDurationMinutes ?? 0,
              )}
            </Button>
            {!trialEligibility.isEligible && trialEligibility.reason && (
              <p className="text-xs text-muted-foreground">
                {trialEligibility.reason}
              </p>
            )}
          </>
        )}

        <Button asChild variant="ghost" className="h-11 w-full rounded-xl">
          <Link
            href={`/explore/programs/plans/subscriptions/${selectedOption.id}`}
          >
            <BookOpen className="mr-2 h-4 w-4" />
            Read plan details
          </Link>
        </Button>
        <PlanBrochureDownload
          planId={selectedOption.id}
          planType="subscriptions"
          className="w-full justify-center"
        />
      </div>
    </>
  );
}

export default function SubscriptionPricingToggle({
  subscriptionOptions,
  handleSubscriptionBooking,
  timezone,
  consultantDetails,
  autoOpenTrial,
  initialPlanId,
  bookingRequest = 0,
}: Readonly<SubscriptionPricingToggleProps>) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const [activeSubscriptionOption, setActiveSubscriptionOption] =
    useState<string>(() =>
      initialPlanId && subscriptionOptions.some((o) => o.id === initialPlanId)
        ? initialPlanId
        : (subscriptionOptions[0]?.id ?? ""),
    );
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [step, setStep] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousBookingRequest = useRef(bookingRequest);
  const [schedulingStartDate, setSchedulingStartDate] = useState<Date | null>(
    null,
  );
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [isTrialModalOpen, setIsTrialModalOpen] = useState(false);
  const [selectedTrialPlan, setSelectedTrialPlan] = useState<{
    id: string;
    title: string;
    trialDurationMinutes: number;
    trialPriceInPaise: number;
    priceCurrency: string;
  } | null>(null);

  useEffect(() => {
    if (bookingRequest > previousBookingRequest.current) {
      returnFocus.current = document.activeElement as HTMLElement;
      const now = new Date();
      setSchedulingStartDate(now);
      setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
      setStep(0);
      setIsDialogOpen(true);
    }
    previousBookingRequest.current = bookingRequest;
  }, [bookingRequest]);

  const selectedOption = useMemo(() => {
    return subscriptionOptions.find(
      (opt) => opt.id === activeSubscriptionOption,
    );
  }, [activeSubscriptionOption, subscriptionOptions]);

  const selectedPlanDetails = useMemo(() => {
    if (!selectedOption?.id) return null;
    return consultantDetails?.subscriptionPlans?.find(
      (p: SubscriptionPlanDetails) => p.id === selectedOption.id,
    );
  }, [selectedOption, consultantDetails]);

  const trialCtaPrice = useMemo(() => {
    const paise = selectedPlanDetails?.trialPriceInPaise ?? 0;
    return paise > 0
      ? formatCurrencyAmount(paise, selectedPlanDetails?.priceCurrency ?? "INR")
      : "Free";
  }, [selectedPlanDetails]);

  const trialEligibility = useTrialEligibility(
    session?.user?.id,
    consultantDetails?.id,
    selectedPlanDetails,
  );

  // Auto-open trial modal when navigated with ?action=trial
  useEffect(() => {
    if (
      autoOpenTrial &&
      selectedPlanDetails?.trialEnabled &&
      trialEligibility.isEligible &&
      !trialEligibility.isLoading
    ) {
      setSelectedTrialPlan({
        id: selectedPlanDetails.id,
        title: selectedPlanDetails.title,
        trialDurationMinutes: selectedPlanDetails.trialDurationMinutes ?? 0,
        trialPriceInPaise: selectedPlanDetails.trialPriceInPaise ?? 0,
        priceCurrency: selectedPlanDetails.priceCurrency ?? "INR",
      });
      setIsTrialModalOpen(true);
    }
  }, [autoOpenTrial, selectedPlanDetails, trialEligibility]);

  const firstCycle = useMemo(() => {
    if (!schedulingStartDate || !selectedOption) return null;
    return firstCycleWindow(
      {
        sessionsPerWeek: selectedOption.sessionsPerWeek ?? 1,
        durationInMonths: selectedOption.durationInMonths ?? 1,
      },
      schedulingStartDate,
      timezone,
    );
  }, [schedulingStartDate, selectedOption, timezone]);

  const validatePeriod = useCallback(
    (start: Date | null): { valid: boolean; message?: string } => {
      if (!start) {
        return { valid: false, message: "Please pick a start date" };
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (start < today) {
        return { valid: false, message: "Start date cannot be in the past" };
      }
      return { valid: true };
    },
    [],
  );

  const validation = useMemo(
    () => validatePeriod(schedulingStartDate),
    [schedulingStartDate, validatePeriod],
  );

  const handleChoosePlan = () => {
    returnFocus.current = document.activeElement as HTMLElement;
    const now = new Date();
    setSchedulingStartDate(now);
    setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setStep(0);
    setIsDialogOpen(true);
  };

  const handleRequestTrial = () => {
    if (!selectedPlanDetails) return;
    if (!trialEligibility.isEligible) {
      toast({
        title: "Not Eligible",
        description:
          trialEligibility.reason ||
          "You have already requested a trial with this consultant",
        variant: "destructive",
      });
      return;
    }
    setSelectedTrialPlan({
      id: selectedPlanDetails.id,
      title: selectedPlanDetails.title,
      trialDurationMinutes: selectedPlanDetails.trialDurationMinutes ?? 0,
      trialPriceInPaise: selectedPlanDetails.trialPriceInPaise ?? 0,
      priceCurrency: selectedPlanDetails.priceCurrency ?? "INR",
    });
    setIsTrialModalOpen(true);
  };

  const handleContinueToCheckout = () => {
    if (
      !validation.valid ||
      !schedulingStartDate ||
      !firstCycle ||
      !selectedOption
    ) {
      toast({
        title: "Invalid start date",
        description: validation.message || "Please pick a valid start date",
        variant: "destructive",
      });
      return;
    }

    handleSubscriptionBooking(selectedOption, {
      startDate: schedulingStartDate,
      endDate: firstCycle.end,
    });

    setIsDialogOpen(false);
  };

  if (subscriptionOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-muted-foreground">
        <p>No subscription plans available at the moment.</p>
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
          To subscribe to services, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  const monthsCount = Math.max(1, selectedOption?.durationInMonths ?? 1);
  const perMonthFormatted = selectedOption
    ? formatCurrencyAmount(
        Math.round(selectedOption.price / monthsCount),
        selectedOption.priceCurrency || "INR",
      )
    : null;

  return (
    <div className="space-y-5">
      <Tabs
        value={activeSubscriptionOption}
        onValueChange={(id) => {
          setActiveSubscriptionOption(id);
          setStep(0);
        }}
      >
        <TabsList
          className="relative flex w-full p-1 bg-muted rounded-2xl border border-border h-auto"
          aria-label="Subscription plan"
        >
          {subscriptionOptions.map((option) => (
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

      {selectedOption && (
        <SubscriptionOptionDetails
          selectedOption={selectedOption}
          selectedPlanDetails={selectedPlanDetails}
          monthsCount={monthsCount}
          perMonthFormatted={perMonthFormatted}
          trialCtaPrice={trialCtaPrice}
          trialEligibility={trialEligibility}
          onChoosePlan={handleChoosePlan}
          onRequestTrial={handleRequestTrial}
        />
      )}

      {/* Guided Start-Date & Review Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
          className="z-[1101] max-h-[88vh] overflow-y-auto rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl sm:max-w-xl"
        >
          <DialogHeader className="p-6 pr-12">
            <DialogTitle className="text-2xl font-semibold text-foreground">
              {step === 0
                ? "When do you want to start?"
                : "Review your mentorship"}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Your consultant schedules one cycle at a time; the first cycle
              starts on the date you pick.
            </DialogDescription>
          </DialogHeader>

          <BookingSteps steps={["Start date", "Review"]} current={step} />

          <div className="space-y-5 p-6">
            {step === 0 ? (
              <SubscriptionStartDateStep
                consultantId={consultantDetails.id}
                calendarMonth={calendarMonth}
                schedulingStartDate={schedulingStartDate}
                timezone={timezone}
                onChangeCalendarMonth={setCalendarMonth}
                onChangeSchedulingStartDate={setSchedulingStartDate}
              />
            ) : (
              selectedOption && (
                <BookingSummary
                  title={selectedOption.description || selectedOption.title}
                  price={formatCurrencyAmount(
                    selectedOption.price,
                    selectedOption.priceCurrency || "INR",
                  )}
                  unit={
                    monthsCount > 1
                      ? `/ ${monthsCount} months (${perMonthFormatted}/mo)`
                      : "/ month"
                  }
                >
                  <p>
                    {selectedOption.durationInMonths} month plan ·{" "}
                    {selectedOption.totalSessions ?? "—"} sessions
                  </p>
                  <p>Time zone: {timezone}</p>
                </BookingSummary>
              )
            )}

            {firstCycle && selectedOption && (
              <div className="rounded-xl border border-border bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  First cycle
                </p>
                <p className="font-medium text-foreground">
                  {formatInTimeZone(firstCycle.start, timezone, "MMM d, yyyy")}{" "}
                  → {formatInTimeZone(firstCycle.end, timezone, "MMM d, yyyy")}
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {selectedOption.sessionsPerWeek ?? 1} session
                  {(selectedOption.sessionsPerWeek ?? 1) === 1 ? "" : "s"} per
                  cycle · {selectedOption.totalSessions ?? "—"} total sessions
                </p>
              </div>
            )}

            {!validation.valid && validation.message && (
              <p role="alert" className="text-sm text-destructive">
                {validation.message}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-6 py-4">
            <Button
              variant="outline"
              onClick={() => (step === 0 ? setIsDialogOpen(false) : setStep(0))}
            >
              {step === 0 ? "Cancel" : "Back"}
            </Button>
            <Button
              disabled={!validation.valid || !selectedOption}
              onClick={step === 0 ? () => setStep(1) : handleContinueToCheckout}
            >
              {step === 0 ? "Review plan" : "Continue to checkout"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {selectedTrialPlan && (
        <TrialBookingModal
          isOpen={isTrialModalOpen}
          onClose={() => {
            setIsTrialModalOpen(false);
            setSelectedTrialPlan(null);
          }}
          consultantProfileId={consultantDetails?.id || ""}
          consultantName={consultantDetails?.user?.name || "Consultant"}
          subscriptionPlanId={selectedTrialPlan.id}
          planTitle={selectedTrialPlan.title}
          trialDurationMinutes={selectedTrialPlan.trialDurationMinutes}
          trialPriceInPaise={selectedTrialPlan.trialPriceInPaise}
          trialCurrency={selectedTrialPlan.priceCurrency}
        />
      )}
    </div>
  );
}
