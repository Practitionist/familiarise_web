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
import { motion } from "framer-motion";
import {
  CalendarIcon,
  CheckCircle2,
  Gift,
  BookOpen,
  Clock,
  ChevronRight,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useState, useMemo, useEffect, useCallback } from "react";
import { PricingOption } from "../defaults";
import { useToast } from "@/hooks/use-toast";
import { addMonths, differenceInDays, format } from "date-fns";
import { useCurrency } from "@/hooks/useCurrency";
import { TrialBookingModal } from "./TrialBookingModal";

interface SubscriptionContentItem {
  id?: string;
  title: string;
  description?: string | null;
  order?: number;
  hoursAllotted?: number | null;
  contentType?: string | null;
}

interface SubscriptionPlanDetails {
  id: string;
  title: string;
  durationInMonths: number;
  trialEnabled?: boolean;
  trialDurationMinutes?: number | null;
  subscriptionContents?: SubscriptionContentItem[] | null;
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
}

export default function SubscriptionPricingToggle({
  subscriptionOptions,
  handleSubscriptionBooking,
  timezone,
  consultantDetails,
  autoOpenTrial,
}: Readonly<SubscriptionPricingToggleProps>) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  // Track the active plan by id so plans that share a duration (e.g. two
  // 3-month subscriptions) remain independently selectable and bookable.
  const [activeSubscriptionOption, setActiveSubscriptionOption] =
    useState<string>(subscriptionOptions[0]?.id ?? "");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [schedulingStartDate, setSchedulingStartDate] = useState<Date | null>(
    null,
  );
  const [schedulingEndDate, setSchedulingEndDate] = useState<Date | null>(null);
  const [isTrialModalOpen, setIsTrialModalOpen] = useState(false);
  const [isRoadmapModalOpen, setIsRoadmapModalOpen] = useState(false);
  const [selectedTrialPlan, setSelectedTrialPlan] = useState<{
    id: string;
    title: string;
    trialDurationMinutes: number;
  } | null>(null);
  const [trialEligibility, setTrialEligibility] = useState<{
    isEligible: boolean;
    reason?: string;
    isLoading: boolean;
  }>({ isEligible: true, isLoading: false });

  const selectedOption = useMemo(() => {
    return subscriptionOptions.find((opt) => opt.id === activeSubscriptionOption);
  }, [activeSubscriptionOption, subscriptionOptions]);

  // Find the subscription plan for the current selection by id (not duration)
  // so duplicate-duration plans resolve to the exact one the user selected.
  const selectedPlanDetails = useMemo(() => {
    if (!selectedOption?.id) return null;
    return consultantDetails?.subscriptionPlans?.find(
      (p: SubscriptionPlanDetails) => p.id === selectedOption.id,
    );
  }, [selectedOption, consultantDetails]);

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
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
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
      });
      setIsTrialModalOpen(true);
    }
  }, [autoOpenTrial, selectedPlanDetails, trialEligibility]);

  const suggestedDates = useMemo(() => {
    if (!selectedOption?.durationInMonths) {
      return { start: new Date(), end: addMonths(new Date(), 1) };
    }
    const start = new Date();
    const end = addMonths(start, selectedOption.durationInMonths);
    return { start, end };
  }, [selectedOption]);

  const validatePeriod = useCallback((
    start: Date | null,
    end: Date | null,
  ): { valid: boolean; message?: string } => {
    if (!start || !end) {
      return {
        valid: false,
        message: "Please select both start and end dates",
      };
    }

    if (end <= start) {
      return { valid: false, message: "End date must be after start date" };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (start < today) {
      return { valid: false, message: "Start date cannot be in the past" };
    }

    const durationInDays = differenceInDays(end, start);
    const expectedDays = (selectedOption?.durationInMonths || 1) * 30;
    const minDays = expectedDays - 7;
    const maxDays = expectedDays + 7;

    if (durationInDays < minDays || durationInDays > maxDays) {
      return {
        valid: false,
        message: `Period should be approximately ${selectedOption?.durationInMonths} month(s). Selected: ${Math.round(durationInDays / 30)} month(s)`,
      };
    }

    return { valid: true };
  }, [selectedOption]);

  const validation = useMemo(() => {
    return validatePeriod(schedulingStartDate, schedulingEndDate);
  }, [schedulingStartDate, schedulingEndDate, validatePeriod]);

  const handleChoosePlan = () => {
    setSchedulingStartDate(suggestedDates.start);
    setSchedulingEndDate(suggestedDates.end);
    setIsDialogOpen(true);
  };

  const handleContinueToCheckout = () => {
    if (
      !validation.valid ||
      !schedulingStartDate ||
      !schedulingEndDate ||
      !selectedOption
    ) {
      toast({
        title: "Invalid Dates",
        description: validation.message || "Please select valid dates",
        variant: "destructive",
      });
      return;
    }

    handleSubscriptionBooking(selectedOption, {
      startDate: schedulingStartDate,
      endDate: schedulingEndDate,
    });

    setIsDialogOpen(false);
  };

  if (subscriptionOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-zinc-400">
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
              <span className="text-5xl font-bold tracking-tight text-white">
                {formatPrice(option.price)}
              </span>
              <span className="text-zinc-500 text-sm mb-1.5">/ month</span>
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
                    setSelectedTrialPlan({
                      id: selectedPlanDetails.id,
                      title: selectedPlanDetails.title,
                      trialDurationMinutes:
                        selectedPlanDetails.trialDurationMinutes ?? 0,
                    });
                    setIsTrialModalOpen(true);
                  }}
                >
                  <Gift className="w-4 h-4 mr-2" />
                  {trialEligibility.isLoading
                    ? "Checking eligibility..."
                    : trialEligibility.isEligible
                      ? `Book Trial (${selectedPlanDetails.trialDurationMinutes ?? 0} min)`
                      : "Trial Already Requested"}
                </Button>
              )}

              {/* View Roadmap Button */}
              {(selectedPlanDetails?.subscriptionContents?.length ?? 0) > 0 && (
                <Button
                  variant="outline"
                  className="w-full bg-white/[0.05] border border-white/[0.12] text-zinc-200 hover:bg-white/[0.10] hover:text-white font-medium rounded-xl h-11 text-sm transition-all duration-200"
                  onClick={() => setIsRoadmapModalOpen(true)}
                >
                  <BookOpen className="w-4 h-4 mr-2" />
                  View Session Roadmap
                </Button>
              )}

              {/* Primary CTA */}
              <Button
                className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-semibold rounded-xl h-12 text-sm tracking-wide transition-all duration-200 hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
                onClick={handleChoosePlan}
              >
                Choose Plan
              </Button>
            </div>
          </motion.div>
          );
        })}
      </div>

      {/* Scheduling Period Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[550px] lg:max-w-[650px] max-h-[90vh] overflow-y-auto bg-zinc-900 text-white p-0 border border-zinc-800 rounded-2xl shadow-2xl z-[1002] scrollbar-hide">
          <DialogHeader className="p-6 border-b border-zinc-800">
            <DialogTitle className="text-xl font-semibold">
              Select Scheduling Period
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Choose when you&apos;d like your{" "}
              {selectedOption?.durationInMonths} month subscription to run
            </DialogDescription>
          </DialogHeader>

          <div className="p-8 space-y-6">
            {/* Date Inputs */}
            <div className="space-y-5">
              {/* Start Date */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2 text-zinc-400">
                  <CalendarIcon className="h-4 w-4" />
                  Start Date
                </label>
                <input
                  type="date"
                  value={
                    schedulingStartDate
                      ? format(schedulingStartDate, "yyyy-MM-dd")
                      : ""
                  }
                  onChange={(e) => {
                    const date = e.target.value
                      ? new Date(e.target.value)
                      : null;
                    setSchedulingStartDate(date);
                  }}
                  min={format(new Date(), "yyyy-MM-dd")}
                  className="w-full px-5 py-3.5 bg-zinc-800/60 border-2 border-zinc-700/50 rounded-xl text-white text-base font-medium focus:outline-none focus:ring-2 focus:ring-zinc-500/50 focus:border-zinc-500 transition-all hover:border-zinc-600 cursor-pointer"
                  style={{ colorScheme: "dark" }}
                />
              </div>

              {/* End Date */}
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2 text-zinc-400">
                  <CalendarIcon className="h-4 w-4" />
                  End Date
                </label>
                <input
                  type="date"
                  value={
                    schedulingEndDate
                      ? format(schedulingEndDate, "yyyy-MM-dd")
                      : ""
                  }
                  onChange={(e) => {
                    const date = e.target.value
                      ? new Date(e.target.value)
                      : null;
                    setSchedulingEndDate(date);
                  }}
                  min={
                    schedulingStartDate
                      ? format(schedulingStartDate, "yyyy-MM-dd")
                      : format(new Date(), "yyyy-MM-dd")
                  }
                  className="w-full px-5 py-3.5 bg-zinc-800/60 border-2 border-zinc-700/50 rounded-xl text-white text-base font-medium focus:outline-none focus:ring-2 focus:ring-zinc-500/50 focus:border-zinc-500 transition-all hover:border-zinc-600 cursor-pointer"
                  style={{ colorScheme: "dark" }}
                />
              </div>
            </div>

            {/* Period Summary */}
            {schedulingStartDate && schedulingEndDate && (
              <div className="p-4 bg-zinc-800/50 rounded-xl border border-zinc-700/50">
                <p className="text-sm text-zinc-500 mb-1">Selected Period:</p>
                <p className="text-white font-semibold text-lg">
                  {format(schedulingStartDate, "MMM dd, yyyy")} →{" "}
                  {format(schedulingEndDate, "MMM dd, yyyy")}
                </p>
                <p className="text-sm text-zinc-500 mt-1">
                  Duration: ~
                  {Math.round(
                    differenceInDays(schedulingEndDate, schedulingStartDate) /
                      30,
                  )}{" "}
                  month(s)
                </p>
              </div>
            )}

            {/* Validation Message */}
            {!validation.valid && validation.message && (
              <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
                <p className="text-sm text-red-400">{validation.message}</p>
              </div>
            )}

            {/* Timezone Info */}
            <div className="p-4 bg-zinc-800/40 border border-zinc-700/50 rounded-xl">
              <p className="text-sm text-zinc-400">
                💡 Timezone: {timezone} (Your local time)
              </p>
            </div>
          </div>

          <div className="bg-zinc-800/50 px-6 py-4 flex justify-center gap-3 rounded-b-2xl border-t border-zinc-800">
            <Button
              onClick={handleContinueToCheckout}
              disabled={!validation.valid}
              className="bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-6"
            >
              Continue to Checkout
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Trial Booking Modal */}
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
        />
      )}

      {/* Session Roadmap Modal */}
      <Dialog open={isRoadmapModalOpen} onOpenChange={setIsRoadmapModalOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col bg-zinc-950 text-white p-0 border border-zinc-800 rounded-2xl shadow-2xl z-[1002]">
          <DialogHeader className="p-6 pb-4 border-b border-zinc-800/50 flex-shrink-0">
            <DialogTitle className="text-xl font-semibold flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-zinc-400" />
              Session Roadmap
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              {selectedPlanDetails?.title || selectedOption?.title} - What
              you&apos;ll learn
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-6 min-h-0 scrollbar-hide">
            {(selectedPlanDetails?.subscriptionContents?.length ?? 0) > 0 ? (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-[19px] top-8 bottom-8 w-0.5 bg-gradient-to-b from-zinc-700 via-zinc-600 to-zinc-700" />

                <div className="space-y-6">
                  {selectedPlanDetails?.subscriptionContents?.map(
                    (content: SubscriptionContentItem, index: number) => (
                      <motion.div
                        key={content.id || index}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.1, duration: 0.3 }}
                        className="relative flex items-start gap-4"
                      >
                        {/* Week badge */}
                        <div className="relative z-10 flex-shrink-0 min-w-[52px] h-10 px-2 rounded-full bg-zinc-800 border-2 border-zinc-700 flex items-center justify-center text-xs font-bold text-white shadow-lg whitespace-nowrap">
                          Week {content.order || index + 1}
                        </div>

                        {/* Content card */}
                        <div className="flex-1 bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 hover:bg-zinc-800/30 transition-colors">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <h4 className="font-semibold text-white text-base mb-1 truncate">
                                {content.title}
                              </h4>
                              {content.description && (
                                <p className="text-sm text-zinc-400 line-clamp-2">
                                  {content.description}
                                </p>
                              )}
                            </div>
                            <ChevronRight className="w-4 h-4 text-zinc-600 flex-shrink-0 mt-1" />
                          </div>

                          {/* Meta info */}
                          <div className="flex items-center gap-4 mt-3 text-xs text-zinc-500">
                            {content.hoursAllotted && (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {content.hoursAllotted}h
                              </span>
                            )}
                            {content.contentType && (
                              <span className="px-2 py-0.5 bg-zinc-800 rounded-full">
                                {content.contentType}
                              </span>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    ),
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-zinc-500">
                <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No detailed roadmap available for this plan.</p>
              </div>
            )}
          </div>

          {/* Summary footer */}
          {(selectedPlanDetails?.subscriptionContents?.length ?? 0) > 0 && (
            <div className="p-4 border-t border-zinc-800/50 bg-zinc-900/50 flex-shrink-0">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-400">
                  {selectedPlanDetails!.subscriptionContents!.length} week
                  {selectedPlanDetails!.subscriptionContents!.length > 1
                    ? "s"
                    : ""}{" "}
                  •{" "}
                  {selectedPlanDetails!.subscriptionContents!.reduce(
                    (acc: number, c: SubscriptionContentItem) => acc + (c.hoursAllotted || 0),
                    0,
                  )}
                  h total
                </span>
                <Button
                  size="sm"
                  className="bg-white text-zinc-900 hover:bg-zinc-100"
                  onClick={() => {
                    setIsRoadmapModalOpen(false);
                    handleChoosePlan();
                  }}
                >
                  Choose This Plan
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
