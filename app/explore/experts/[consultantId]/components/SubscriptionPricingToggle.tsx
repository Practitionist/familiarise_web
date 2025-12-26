"use client";

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
import { CalendarIcon, CheckCircle2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { useState, useMemo } from "react";
import { PricingOption } from "../defaults";
import { useToast } from "@/hooks/use-toast";
import { addMonths, differenceInDays, format } from "date-fns";
import { formatCurrency } from "@/app/checkout/plans/math";

interface SubscriptionPricingToggleProps {
  subscriptionOptions: PricingOption[];
  consultantDetails: any;
  handleSubscriptionBooking: (
    option: PricingOption,
    schedulingPeriod: { startDate: Date; endDate: Date },
  ) => void;
  timezone: string;
}

export default function SubscriptionPricingToggle({
  subscriptionOptions,
  handleSubscriptionBooking,
  timezone,
  consultantDetails,
}: Readonly<SubscriptionPricingToggleProps>) {
  const { data: session } = useSession();
  const { toast } = useToast();
  const [activeSubscriptionOption, setActiveSubscriptionOption] = useState(
    subscriptionOptions.length > 0
      ? subscriptionOptions[0].title.toLowerCase().replace(" ", "-")
      : "",
  );
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [schedulingStartDate, setSchedulingStartDate] = useState<Date | null>(
    null,
  );
  const [schedulingEndDate, setSchedulingEndDate] = useState<Date | null>(null);

  const selectedOption = useMemo(() => {
    return subscriptionOptions.find(
      (opt) =>
        opt.title.toLowerCase().replace(" ", "-") === activeSubscriptionOption,
    );
  }, [activeSubscriptionOption, subscriptionOptions]);

  const suggestedDates = useMemo(() => {
    if (!selectedOption?.durationInMonths) {
      return { start: new Date(), end: addMonths(new Date(), 1) };
    }
    const start = new Date();
    const end = addMonths(start, selectedOption.durationInMonths);
    return { start, end };
  }, [selectedOption]);

  const validatePeriod = (
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
  };

  const validation = useMemo(() => {
    return validatePeriod(schedulingStartDate, schedulingEndDate);
  }, [schedulingStartDate, schedulingEndDate]);

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
      className="w-full space-y-6"
    >
      {/* Duration Toggle - Black/Silver Theme */}
      <TabsList className="flex w-full p-1 bg-zinc-800/50 backdrop-blur-sm rounded-xl border border-zinc-700/50">
        {subscriptionOptions.map((option) => (
          <TabsTrigger
            key={option.durationInMonths}
            value={option.title.toLowerCase().replace(" ", "-")}
            className={`${activeSubscriptionOption ===
                option.title.toLowerCase().replace(" ", "-")
                ? "bg-white text-zinc-900 shadow-sm"
                : "text-zinc-400 hover:text-white hover:bg-zinc-700/50"
              } flex-1 px-2 sm:px-4 py-2 rounded-lg font-medium text-xs sm:text-sm transition-all duration-200 whitespace-nowrap`}
          >
            {option.title}
          </TabsTrigger>
        ))}
      </TabsList>

      <div className="grid grid-cols-1 gap-4">
        {subscriptionOptions.map((option) => (
          <motion.div
            key={option.durationInMonths}
            initial={{ opacity: 0, y: 10 }}
            animate={{
              opacity:
                activeSubscriptionOption ===
                  option.title.toLowerCase().replace(" ", "-")
                  ? 1
                  : 0,
              y: 0,
            }}
            transition={{ duration: 0.2 }}
            className={
              activeSubscriptionOption ===
                option.title.toLowerCase().replace(" ", "-")
                ? "block"
                : "hidden"
            }
          >
            {/* Pricing Card - Silver/Zinc Gradient */}
            <div className="bg-gradient-to-br from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 rounded-xl p-6 backdrop-blur-sm">
              <div className="mb-1">
                <h3 className="text-xl font-bold text-white">{option.title}</h3>
                <p className="text-sm text-zinc-400">{option.description}</p>
              </div>

              <div className="my-4">
                <span className="text-4xl font-bold text-white">
                  {formatCurrency(option.price, option.priceCurrency)}
                </span>
              </div>

              {option.features && option.features.length > 0 && (
                <div className="space-y-2 mb-6">
                  <p className="text-sm text-zinc-400">Includes:</p>
                  <ul className="space-y-2">
                    {option.features?.map((feature, index) => (
                      <li
                        key={`feature-${index}`}
                        className="text-zinc-300 flex items-center text-sm"
                      >
                        <CheckCircle2 className="w-4 h-4 mr-2 text-zinc-500" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-medium rounded-xl h-11"
                    onClick={handleChoosePlan}
                  >
                    Choose Plan
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[550px] lg:max-w-[650px] bg-zinc-900 text-white p-0 border border-zinc-800 rounded-2xl shadow-2xl">
                  <DialogHeader className="p-6 border-b border-zinc-800">
                    <DialogTitle className="text-xl font-semibold">
                      Select Scheduling Period
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400">
                      Choose when you&apos;d like your {option.durationInMonths}{" "}
                      month subscription to run
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
                        <p className="text-sm text-zinc-500 mb-1">
                          Selected Period:
                        </p>
                        <p className="text-white font-semibold text-lg">
                          {format(schedulingStartDate, "MMM dd, yyyy")} →{" "}
                          {format(schedulingEndDate, "MMM dd, yyyy")}
                        </p>
                        <p className="text-sm text-zinc-500 mt-1">
                          Duration: ~
                          {Math.round(
                            differenceInDays(
                              schedulingEndDate,
                              schedulingStartDate,
                            ) / 30,
                          )}{" "}
                          month(s)
                        </p>
                      </div>
                    )}

                    {/* Validation Message */}
                    {!validation.valid && validation.message && (
                      <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
                        <p className="text-sm text-red-400">
                          {validation.message}
                        </p>
                      </div>
                    )}

                    {/* Timezone Info */}
                    <div className="p-4 bg-zinc-800/40 border border-zinc-700/50 rounded-xl">
                      <p className="text-sm text-zinc-400">
                        💡 Timezone: {timezone} (Your local time)
                      </p>
                    </div>
                  </div>
                  <div className="bg-zinc-800/50 px-6 py-4 flex justify-end gap-3 rounded-b-2xl border-t border-zinc-800">
                    <Button
                      variant="ghost"
                      className="text-zinc-400 hover:text-white hover:bg-zinc-700/50"
                      onClick={() => setIsDialogOpen(false)}
                    >
                      Cancel
                    </Button>
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
            </div>
          </motion.div>
        ))}
      </div>
    </Tabs>
  );
}
