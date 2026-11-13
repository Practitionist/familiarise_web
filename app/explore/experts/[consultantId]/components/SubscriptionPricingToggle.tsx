"use client";

import * as Sentry from "@sentry/nextjs";
import { planDurationText } from "@/lib/offerings/plan-length-copy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { CheckCircle2, Gift, BookOpen } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { zoneDisplayLabel } from "@/lib/time/viewer-zone";
import Link from "next/link";
import { useState, useMemo, useEffect, useCallback } from "react";
import { PricingOption } from "../defaults";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { firstCycleWindow, lastInstantBefore } from "@/lib/booking/entitlement";
import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import { buyerDisplayPricePaise } from "@/lib/payments/pricing/display-price";
import { formatCurrencyAmount } from "@/utils/formatting";
import { MonthGrid } from "@/components/scheduling/MonthGrid";
import { calendarDateKey, calendarDayOf } from "@/lib/time/grid-zone";
import { MentorshipTrialStep } from "./MentorshipTrialStep";
import { usePlanBuyBlocked } from "../hooks/usePlanBuyBlocked";

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
  /** Server-derived: the expert's limit on live plan clients is reached. */
  planClientsFull?: boolean;
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
}

export default function SubscriptionPricingToggle({
  subscriptionOptions,
  handleSubscriptionBooking,
  timezone,
  consultantDetails,
  autoOpenTrial,
}: Readonly<SubscriptionPricingToggleProps>) {
  const { data: session } = useSession();
  const buyBlocked = usePlanBuyBlocked(
    consultantDetails.id,
    consultantDetails.planClientsFull === true,
    session?.user?.id,
  );
  const { toast } = useToast();
  const { gstRegistered, noteFor } = useBuyerPrice();
  // Track the active plan by id so plans that share a duration (e.g. two
  // 3-month subscriptions) remain independently selectable and bookable.
  const [activeSubscriptionOption, setActiveSubscriptionOption] =
    useState<string>(subscriptionOptions[0]?.id ?? "");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // Step one chooses the start; step two picks a trial's time.
  const [step, setStep] = useState<"start" | "trial">("start");
  const [schedulingStartDate, setSchedulingStartDate] = useState<Date | null>(
    null,
  );
  const [startMonth, setStartMonth] = useState<Date | null>(null);
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
    if (paise <= 0) return "Free";
    const formatted = formatCurrencyAmount(
      buyerDisplayPricePaise(paise, gstRegistered),
      selectedPlanDetails?.priceCurrency ?? "INR",
    );
    return gstRegistered ? `${formatted} incl. GST` : formatted;
  }, [selectedPlanDetails, gstRegistered]);

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

  const trialOpen =
    selectedPlanDetails?.trialEnabled === true &&
    trialEligibility.isEligible &&
    !trialEligibility.isLoading;
  const openTrialStep = useCallback(() => {
    setStep("trial");
    setIsDialogOpen(true);
  }, []);

  // ?action=trial opens the mentorship dialog on its trial step.
  useEffect(() => {
    if (autoOpenTrial && trialOpen) openTrialStep();
  }, [autoOpenTrial, trialOpen, openTrialStep]);

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

  // Today in the viewer's zone; the past is never offered.
  const today = calendarDayOf(new Date(), timezone);
  const todayKey = calendarDateKey(today);
  const validation = useMemo((): { valid: boolean; message?: string } => {
    if (!schedulingStartDate) {
      return { valid: false, message: "Please pick a start date" };
    }
    if (calendarDateKey(schedulingStartDate) < todayKey) {
      return { valid: false, message: "Start date cannot be in the past" };
    }
    return { valid: true };
  }, [schedulingStartDate, todayKey]);

  /** Local midnight of a calendar date, the start instant checkout derives from. */
  const startOfDay = (day: Date) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate());

  const handleChoosePlan = () => {
    setSchedulingStartDate(startOfDay(today));
    setStartMonth(null);
    setStep("start");
    setIsDialogOpen(true);
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

    // The end travels for the checkout URL's shape only; the server ignores it.
    handleSubscriptionBooking(selectedOption, {
      startDate: schedulingStartDate,
      endDate: firstCycle.end,
    });

    setIsDialogOpen(false);
  };

  if (subscriptionOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-zinc-400">
        <p>No mentorship plans available at the moment.</p>
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
          To subscribe to services, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={activeSubscriptionOption}
      onValueChange={setActiveSubscriptionOption}
      className="w-full space-y-5"
    >
      {/* Segmented pill duration toggle */}
      <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm h-auto">
        {subscriptionOptions.map((option) => {
          const isActive = activeSubscriptionOption === option.id;
          return (
            <TabsTrigger
              key={option.id}
              value={option.id}
              className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-zinc-400 transition-colors duration-300 z-10 h-auto whitespace-nowrap"
            >
              {isActive && (
                <motion.div
                  layoutId="subscription-duration-pill"
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
        {subscriptionOptions.map((option) => {
          const isActive = activeSubscriptionOption === option.id;
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
              {/* Pricing content — lives directly in glass parent */}
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-white">{option.title}</h3>
                <p className="text-xs text-zinc-500">{option.description}</p>
              </div>

              <div className="flex items-end gap-2 my-5">
                {/* #1396 — this is the headline price of a plan the server will
                  charge, so it renders in the plan's own currency, exactly as
                  the trial price above it does for the reason given at #1167.
                  `formatPrice` took INR paise and applied the viewer's FX rate,
                  which relabelled the plan and disagreed with the trial line
                  two elements away. */}
                <span className="text-5xl font-bold tracking-tight text-white">
                  {formatCurrencyAmount(
                    buyerDisplayPricePaise(option.price, gstRegistered),
                    option.priceCurrency || "INR",
                  )}
                </span>
                <span className="text-zinc-500 text-sm mb-1.5">
                  for {planDurationText(option)}
                  {noteFor(option.price) ? ` · ${noteFor(option.price)}` : ""}
                </span>
              </div>

              {option.features && option.features.length > 0 && (
                <>
                  <div className="border-t border-white/[0.06] mb-4" />
                  <div className="space-y-2 mb-5">
                    <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">
                      Includes
                    </p>
                    <ul className="space-y-2">
                      {option.features?.map((feature, index) => (
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

              {/* Button stack with proper spacing */}
              <div className="space-y-2.5">
                {/* Trial Button */}
                {selectedPlanDetails?.trialEnabled && (
                  <Button
                    className={`w-full font-semibold rounded-xl h-12 text-sm transition-all duration-200 ${
                      trialEligibility.isEligible && !trialEligibility.isLoading
                        ? "bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-900/30"
                        : "bg-zinc-700/50 text-zinc-500 cursor-not-allowed"
                    }`}
                    disabled={
                      !trialEligibility.isEligible || trialEligibility.isLoading
                    }
                    onClick={() => {
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
                      openTrialStep();
                    }}
                  >
                    <Gift className="w-4 h-4 mr-2" />
                    {trialEligibility.isLoading
                      ? "Checking eligibility..."
                      : trialEligibility.isEligible
                        ? `Book Trial (${trialCtaPrice}, ${selectedPlanDetails.trialDurationMinutes ?? 0} min)`
                        : "Trial Already Requested"}
                  </Button>
                )}

                {/* The toggle is a CHOOSER, not a brochure: pick a tier here,
                  read the roadmap/FAQ on the plan page. It used to try to be
                  both, which is what forced a 12-week roadmap into a 450px
                  column and then into a modal. */}
                {selectedPlanDetails?.id && (
                  <Button
                    asChild
                    variant="outline"
                    className="w-full bg-white/[0.05] border border-white/[0.12] text-zinc-200 hover:bg-white/[0.10] hover:text-white font-medium rounded-xl h-11 text-sm transition-all duration-200"
                  >
                    <Link
                      href={`/explore/programs/plans/subscriptions/${selectedPlanDetails.id}`}
                    >
                      <BookOpen className="w-4 h-4 mr-2" />
                      Open details
                    </Link>
                  </Button>
                )}

                {/* Primary CTA */}
                <Button
                  className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-semibold rounded-xl h-12 text-sm tracking-wide transition-all duration-200 hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
                  onClick={handleChoosePlan}
                  disabled={buyBlocked}
                >
                  {buyBlocked ? "Fully booked" : "Start mentorship"}
                </Button>
                {buyBlocked && (
                  <p className="text-center text-xs text-zinc-400">
                    This expert isn&apos;t taking new mentorship clients right
                    now.
                  </p>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* The mentorship dialog: choose a start, or step on to a trial. */}
      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) setStep("start");
        }}
      >
        {/* Same shell as the consultation booking dialog: centred, inside a
            gutter, header and button fixed, only the middle scrolls. */}
        <DialogContent
          className={`flex max-h-[min(calc(100dvh-1.5rem),52rem)] w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-white shadow-2xl sm:rounded-2xl ${
            step === "trial"
              ? "sm:max-w-[640px] md:max-w-[880px] lg:max-w-[960px]"
              : "sm:max-w-[550px] lg:max-w-[650px]"
          }`}
        >
          <DialogHeader className="shrink-0 border-b border-zinc-800 p-4 pr-12 sm:p-6 sm:pr-14">
            <DialogTitle className="text-xl font-semibold">
              {step === "trial"
                ? `Book a trial with ${consultantDetails?.user?.name || "this expert"}`
                : "When do you want to start?"}
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              {step === "trial"
                ? `Pick a time for a ${selectedPlanDetails?.trialDurationMinutes ?? 0}-minute trial.`
                : "Your consultant schedules one cycle at a time; the first cycle starts on the date you pick."}
            </DialogDescription>
          </DialogHeader>

          {step === "trial" && selectedPlanDetails ? (
            <DialogBody className="flex min-h-0 flex-col p-0">
              <MentorshipTrialStep
                consultantProfileId={consultantDetails?.id || ""}
                consultantName={consultantDetails?.user?.name || "this expert"}
                subscriptionPlanId={selectedPlanDetails.id}
                planTitle={selectedPlanDetails.title}
                trialDurationMinutes={
                  selectedPlanDetails.trialDurationMinutes ?? 0
                }
                trialPriceInPaise={selectedPlanDetails.trialPriceInPaise ?? 0}
                trialCurrency={selectedPlanDetails.priceCurrency ?? "INR"}
                zone={timezone}
                onBack={() => setStep("start")}
                onDone={() => {
                  setIsDialogOpen(false);
                  setStep("start");
                }}
              />
            </DialogBody>
          ) : (
            <>
              <DialogBody className="space-y-6 p-4 sm:p-8">
                <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/60 p-3 sm:p-5">
                  <MonthGrid
                    month={
                      startMonth ??
                      new Date(
                        (schedulingStartDate ?? today).getFullYear(),
                        (schedulingStartDate ?? today).getMonth(),
                        1,
                        12,
                      )
                    }
                    onMonthChange={(month) =>
                      setStartMonth(
                        new Date(month.getFullYear(), month.getMonth(), 1, 12),
                      )
                    }
                    selectedKey={
                      schedulingStartDate
                        ? calendarDateKey(schedulingStartDate)
                        : null
                    }
                    onSelect={(day) => setSchedulingStartDate(startOfDay(day))}
                    today={today}
                    isDisabled={(day) => calendarDateKey(day) < todayKey}
                    canGoBack={
                      calendarDateKey(
                        startMonth ?? schedulingStartDate ?? today,
                      ).slice(0, 7) > todayKey.slice(0, 7)
                    }
                    canGoForward
                    theme="dark"
                  />
                </div>

                {/* First-cycle summary */}
                {schedulingStartDate && firstCycle && selectedOption && (
                  <div className="p-4 bg-zinc-800/50 rounded-xl border border-zinc-700/50">
                    <p className="text-sm text-zinc-500 mb-1">First cycle:</p>
                    <p className="text-white font-semibold text-lg">
                      {format(firstCycle.start, "MMM dd, yyyy")} →{" "}
                      {format(
                        lastInstantBefore(firstCycle.end),
                        "MMM dd, yyyy",
                      )}
                    </p>
                    <p className="text-sm text-zinc-500 mt-1">
                      {selectedOption.sessionsPerWeek ?? 1} session
                      {(selectedOption.sessionsPerWeek ?? 1) === 1
                        ? ""
                        : "s"}{" "}
                      per cycle · {selectedOption.totalSessions ?? "—"} in the
                      plan
                    </p>
                  </div>
                )}

                {!validation.valid && validation.message && (
                  <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <p className="text-sm text-red-400">{validation.message}</p>
                  </div>
                )}

                <div className="p-4 bg-zinc-800/40 border border-zinc-700/50 rounded-xl">
                  <p className="text-sm text-zinc-400">
                    Times shown in {zoneDisplayLabel(new Date(), timezone)}
                  </p>
                </div>
              </DialogBody>

              <div className="shrink-0 bg-zinc-800/50 px-4 sm:px-6 py-4 flex flex-col-reverse gap-3 rounded-b-2xl border-t border-zinc-800 sm:flex-row sm:justify-end">
                {trialOpen && (
                  <Button
                    variant="outline"
                    onClick={() => setStep("trial")}
                    className="w-full sm:w-auto border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-800 hover:text-white"
                  >
                    <Gift aria-hidden="true" className="mr-2 h-4 w-4" />
                    Book Trial ({trialCtaPrice})
                  </Button>
                )}
                <Button
                  onClick={handleContinueToCheckout}
                  disabled={!validation.valid || buyBlocked}
                  className="w-full sm:w-auto bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-6"
                >
                  Continue to Checkout
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
