"use client";

import * as Sentry from "@sentry/nextjs";
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
import { BookingSteps } from "@/components/booking/BookingSteps";
import { BookingSummary } from "@/components/booking/BookingSummary";
import { formatInTimeZone } from "date-fns-tz";
import { useSession } from "@/lib/auth-client";
import Link from "next/link";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { PricingOption } from "../defaults";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { firstCycleWindow } from "@/lib/booking/entitlement";
import { formatCurrencyAmount } from "@/utils/formatting";
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
  // #780 result extension already made this a number in paise by the time it
  // crosses the RSC boundary; the fetcher `include`s it, it was simply never
  // declared here and so never rendered (#1167).
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
  // Track the active plan by id so plans that share a duration (e.g. two
  // 3-month subscriptions) remain independently selectable and bookable.
  const [activeSubscriptionOption, setActiveSubscriptionOption] =
    useState<string>(
      subscriptionOptions.some((o) => o.id === initialPlanId)
        ? initialPlanId!
        : (subscriptionOptions[0]?.id ?? ""),
    );
  const [step, setStep] = useState(0);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousBookingRequest = useRef(bookingRequest);
  const [schedulingStartDate, setSchedulingStartDate] = useState<Date | null>(
    null,
  );
  const [isTrialModalOpen, setIsTrialModalOpen] = useState(false);
  const [selectedTrialPlan, setSelectedTrialPlan] = useState<{
    id: string;
    title: string;
    trialDurationMinutes: number;
    trialPriceInPaise: number;
    priceCurrency: string;
  } | null>(null);
  const [trialEligibility, setTrialEligibility] = useState<{
    isEligible: boolean;
    reason?: string;
    isLoading: boolean;
  }>({ isEligible: true, isLoading: false });

  const selectedOption = useMemo(() => {
    return subscriptionOptions.find(
      (opt) => opt.id === activeSubscriptionOption,
    );
  }, [activeSubscriptionOption, subscriptionOptions]);

  // Find the subscription plan for the current selection by id (not duration)
  // so duplicate-duration plans resolve to the exact one the user selected.
  const selectedPlanDetails = useMemo(() => {
    if (!selectedOption?.id) return null;
    return consultantDetails?.subscriptionPlans?.find(
      (p: SubscriptionPlanDetails) => p.id === selectedOption.id,
    );
  }, [selectedOption, consultantDetails]);

  // #1167 — the CTA names the price. `formatPrice` is not usable here: it takes
  // INR paise and applies the viewer's FX rate, which would relabel a plan
  // already denominated in another currency.
  const trialCtaPrice = useMemo(() => {
    const paise = selectedPlanDetails?.trialPriceInPaise ?? 0;
    return paise > 0
      ? formatCurrencyAmount(paise, selectedPlanDetails?.priceCurrency ?? "INR")
      : "Free";
  }, [selectedPlanDetails]);

  // Check trial eligibility when plan changes
  useEffect(() => {
    const checkEligibility = async () => {
      if (
        !session?.user?.id ||
        !selectedPlanDetails?.id ||
        !selectedPlanDetails?.trialEnabled
      ) {
        return;
      }

      setTrialEligibility((prev) => ({ ...prev, isLoading: true }));

      try {
        // First get consultee profile
        const profileResponse = await fetch(
          `/api/profiles/consultee?userId=${session.user.id}`,
        );
        if (!profileResponse.ok) {
          setTrialEligibility({
            isEligible: false,
            reason: "Could not verify profile",
            isLoading: false,
          });
          return;
        }
        const { data: consulteeProfile } = await profileResponse.json();

        if (!consulteeProfile?.id) {
          setTrialEligibility({ isEligible: true, isLoading: false }); // No profile yet, eligible
          return;
        }

        // Check eligibility
        const eligibilityResponse = await fetch(
          `/api/trials/check-eligibility?consulteeProfileId=${consulteeProfile.id}&consultantProfileId=${consultantDetails?.id}&subscriptionPlanId=${selectedPlanDetails.id}`,
        );

        if (eligibilityResponse.ok) {
          const { data } = await eligibilityResponse.json();
          setTrialEligibility({
            isEligible: data.isEligible,
            reason: data.reason,
            isLoading: false,
          });
        } else {
          setTrialEligibility({ isEligible: true, isLoading: false });
        }
      } catch (error) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client" } },
        );
        console.error("Error checking trial eligibility:", error);
        setTrialEligibility({ isEligible: true, isLoading: false });
      }
    };

    checkEligibility();
  }, [
    session?.user?.id,
    selectedPlanDetails?.id,
    selectedPlanDetails?.trialEnabled,
    consultantDetails?.id,
  ]);

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

  // #1766 — the buyer picks a START only; the window is the first cycle and
  // the server derives it again in the consultant's zone. Shown here in the
  // viewer's zone so the summary reads in their own calendar.
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
    setSchedulingStartDate((previous) => previous ?? new Date());
    setStep(0);
    setIsDialogOpen(true);
  };

  useEffect(() => {
    if (bookingRequest > previousBookingRequest.current) {
      returnFocus.current = document.activeElement as HTMLElement;
      setSchedulingStartDate((previous) => previous ?? new Date());
      setStep(0);
      setIsDialogOpen(true);
    }
    previousBookingRequest.current = bookingRequest;
  }, [bookingRequest]);

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

    // The end travels for the checkout URL's shape only; the server ignores it.
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
        <p className="text-zinc-500">
          To subscribe to services, please sign in with a consultee account.
        </p>
      </div>
    );
  }

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
          className="pricing-segments w-full"
          aria-label="Mentorship plan"
        >
          {subscriptionOptions.map((option) => (
            <TabsTrigger key={option.id} value={option.id}>
              {option.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {selectedOption && (
        <>
          <div>
            <h3 className="text-lg font-semibold">{selectedOption.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {selectedOption.description}
            </p>
          </div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight break-all">
              {formatCurrencyAmount(
                selectedOption.price,
                selectedOption.priceCurrency || "INR",
              )}
            </span>
            <span className="text-sm text-muted-foreground">/ plan</span>
          </div>
          {!!selectedOption.features?.length && (
            <ul className="space-y-3 text-sm">
              {selectedOption.features.map((feature, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                  {feature}
                </li>
              ))}
            </ul>
          )}
          <Button className="h-12 w-full rounded-xl" onClick={handleChoosePlan}>
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
                onClick={() => {
                  setSelectedTrialPlan({
                    id: selectedPlanDetails.id,
                    title: selectedPlanDetails.title,
                    trialDurationMinutes:
                      selectedPlanDetails.trialDurationMinutes ?? 0,
                    trialPriceInPaise:
                      selectedPlanDetails.trialPriceInPaise ?? 0,
                    priceCurrency: selectedPlanDetails.priceCurrency ?? "INR",
                  });
                  setIsTrialModalOpen(true);
                }}
              >
                <Gift className="mr-2 h-4 w-4 shrink-0" />
                {trialEligibility.isLoading
                  ? "Checking trial eligibility…"
                  : trialEligibility.isEligible
                    ? `Request a trial (${trialCtaPrice}, ${selectedPlanDetails.trialDurationMinutes ?? 0} min)`
                    : "Trial already requested"}
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
        </>
      )}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
          overlayClassName="z-[1100]"
          className="booking-dialog z-[1101] sm:max-w-xl"
        >
          <DialogHeader className="p-6 pr-12">
            <DialogTitle className="text-2xl">
              {step === 0
                ? "When do you want to start?"
                : "Review your mentorship"}
            </DialogTitle>
            <DialogDescription>
              Your consultant schedules one cycle at a time.
            </DialogDescription>
          </DialogHeader>
          <BookingSteps steps={["Start date", "Review"]} current={step} />
          <div className="space-y-5 p-6">
            {step === 0 ? (
              <div className="space-y-2">
                <label
                  htmlFor={`subscription-start-${consultantDetails.id}`}
                  className="flex items-center gap-2 text-sm font-medium"
                >
                  <CalendarIcon className="h-4 w-4" />
                  Start date
                </label>
                <input
                  id={`subscription-start-${consultantDetails.id}`}
                  type="date"
                  value={
                    schedulingStartDate
                      ? format(schedulingStartDate, "yyyy-MM-dd")
                      : ""
                  }
                  min={format(new Date(), "yyyy-MM-dd")}
                  className="h-12 w-full rounded-xl border border-input bg-background px-4 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ colorScheme: "light" }}
                  onChange={(event) => {
                    const [y, m, d] = event.target.value.split("-").map(Number);
                    setSchedulingStartDate(
                      event.target.value ? new Date(y, m - 1, d) : null,
                    );
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Time zone: {timezone}
                </p>
              </div>
            ) : (
              selectedOption && (
                <BookingSummary
                  title={selectedOption.description || selectedOption.title}
                  price={formatCurrencyAmount(
                    selectedOption.price,
                    selectedOption.priceCurrency || "INR",
                  )}
                  unit="/ plan"
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
                <p className="explore-eyebrow mb-2">First cycle</p>
                <p className="font-medium">
                  {formatInTimeZone(firstCycle.start, timezone, "MMM d, yyyy")}{" "}
                  → {formatInTimeZone(firstCycle.end, timezone, "MMM d, yyyy")}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedOption.sessionsPerWeek ?? 1} session
                  {(selectedOption.sessionsPerWeek ?? 1) === 1 ? "" : "s"} per
                  cycle
                </p>
              </div>
            )}
            {!validation.valid && validation.message && (
              <p role="alert" className="text-sm text-destructive">
                {validation.message}
              </p>
            )}
          </div>
          <div className="booking-footer">
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
          consultantProfileId={consultantDetails.id}
          consultantName={consultantDetails.user?.name || "Consultant"}
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
