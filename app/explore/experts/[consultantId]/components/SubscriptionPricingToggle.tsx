"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { CalendarIcon } from "lucide-react";
import { useSession } from "next-auth/react";
import { useState, useMemo } from "react";
import { PricingOption } from "../defaults";
import { useToast } from "@/hooks/use-toast";
import { addMonths, differenceInDays, format } from "date-fns";

interface SubscriptionPricingToggleProps {
  subscriptionOptions: PricingOption[];
  consultantDetails: any;
  handleSubscriptionBooking: (
    option: PricingOption,
    schedulingPeriod: { startDate: Date; endDate: Date }
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
  const [schedulingStartDate, setSchedulingStartDate] = useState<Date | null>(null);
  const [schedulingEndDate, setSchedulingEndDate] = useState<Date | null>(null);

  // Get the currently selected subscription option
  const selectedOption = useMemo(() => {
    return subscriptionOptions.find(
      (opt) =>
        opt.title.toLowerCase().replace(" ", "-") === activeSubscriptionOption,
    );
  }, [activeSubscriptionOption, subscriptionOptions]);

  // Calculate suggested dates based on subscription duration
  const suggestedDates = useMemo(() => {
    if (!selectedOption?.durationInMonths) {
      return { start: new Date(), end: addMonths(new Date(), 1) };
    }
    const start = new Date();
    const end = addMonths(start, selectedOption.durationInMonths);
    return { start, end };
  }, [selectedOption]);

  // Validate scheduling period
  const validatePeriod = (start: Date | null, end: Date | null): { valid: boolean; message?: string } => {
    if (!start || !end) {
      return { valid: false, message: "Please select both start and end dates" };
    }

    if (end <= start) {
      return { valid: false, message: "End date must be after start date" };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (start < today) {
      return { valid: false, message: "Start date cannot be in the past" };
    }

    // Check if period matches subscription duration (±7 days flexibility)
    const durationInDays = differenceInDays(end, start);
    const expectedDays = (selectedOption?.durationInMonths || 1) * 30; // Approximate days per month
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
    // Set suggested dates when dialog opens
    setSchedulingStartDate(suggestedDates.start);
    setSchedulingEndDate(suggestedDates.end);
    setIsDialogOpen(true);
  };

  const handleContinueToCheckout = () => {
    if (!validation.valid || !schedulingStartDate || !schedulingEndDate || !selectedOption) {
      toast({
        title: "Invalid Dates",
        description: validation.message || "Please select valid dates",
        variant: "destructive",
      });
      return;
    }

    // Pass dates to handler
    handleSubscriptionBooking(selectedOption, {
      startDate: schedulingStartDate,
      endDate: schedulingEndDate,
    });

    setIsDialogOpen(false);
  };

  if (subscriptionOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-gray-500">
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
        <h3 className="text-2xl font-medium tracking-tight text-gray-700">
          Consultee Access Required
        </h3>
        <p className="text-gray-500">
          To subscribe to services, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={activeSubscriptionOption}
      onValueChange={setActiveSubscriptionOption}
      className="w-full space-y-8"
    >
        <TabsList className="inline-flex p-1 bg-gray-800/30 backdrop-blur-sm rounded-xl border border-gray-700/30 shadow-md">
          {subscriptionOptions.map((option) => (
            <TabsTrigger
              key={option.durationInMonths}
              value={option.title.toLowerCase().replace(" ", "-")}
              className={`${
                activeSubscriptionOption ===
                option.title.toLowerCase().replace(" ", "-")
                  ? "bg-white text-black shadow-sm"
                  : "text-gray-300 hover:text-white hover:bg-gray-700/30"
              } px-5 py-2 rounded-lg font-medium transition-all duration-200 ease-out`}
            >
              {option.title}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="grid grid-cols-1 gap-6">
          {subscriptionOptions.map((option) => (
            <motion.div
              key={option.durationInMonths}
              initial={{ opacity: 0, y: 20 }}
              animate={{
                opacity:
                  activeSubscriptionOption ===
                  option.title.toLowerCase().replace(" ", "-")
                    ? 1
                    : 0,
                y: 0,
              }}
              transition={{ duration: 0.3 }}
              className={
                activeSubscriptionOption ===
                option.title.toLowerCase().replace(" ", "-")
                  ? "block"
                  : "hidden"
              }
            >
              <Card className="bg-gray-800/50 border-gray-700 shadow-lg hover:shadow-xl transition-all duration-300 backdrop-blur-sm">
                <CardHeader>
                  <CardTitle className="text-2xl font-bold text-white">
                    {option.title}
                  </CardTitle>
                  <CardDescription className="text-gray-300">
                    {option.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="text-5xl font-bold text-white">
                    ${option.price}
                  </div>
                  <div className="space-y-2">
                    <p className="text-white">Includes:</p>
                    <ul className="space-y-1 pl-4">
                      {option.features?.map((feature, index) => (
                        <li
                          key={`feature-${index}`}
                          className="text-gray-300 flex items-center"
                        >
                          <svg
                            className="w-4 h-4 mr-2 text-white"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full bg-white text-black hover:bg-gray-100 transition-colors duration-300"
                        onClick={handleChoosePlan}
                      >
                        Choose Plan
                      </Button>
                    </DialogTrigger>
                    <DialogPortal>
                      <DialogOverlay className="bg-black/30" />
                      <DialogContent className="sm:max-w-[500px] bg-[#15171B] text-white p-0 border-0 rounded-lg">
                      <DialogHeader className="p-6 border-b border-gray-800">
                        <DialogTitle>Select Scheduling Period</DialogTitle>
                        <DialogDescription className="text-gray-400">
                          Choose when you'd like your {option.durationInMonths}{" "}
                          month subscription to run
                        </DialogDescription>
                      </DialogHeader>
                      <div className="p-8 space-y-8">
                        {/* Elegant Date Inputs */}
                        <div className="space-y-6">
                          {/* Start Date */}
                          <div className="space-y-3">
                            <label className="text-sm font-medium flex items-center gap-2 text-gray-300">
                              <CalendarIcon className="h-5 w-5" />
                              Start Date
                            </label>
                            <input
                              type="date"
                              value={schedulingStartDate ? format(schedulingStartDate, "yyyy-MM-dd") : ""}
                              onChange={(e) => {
                                const date = e.target.value ? new Date(e.target.value) : null;
                                setSchedulingStartDate(date);
                              }}
                              min={format(new Date(), "yyyy-MM-dd")}
                              className="w-full px-6 py-4 bg-gray-800/60 border-2 border-gray-700/50 rounded-xl text-white text-lg font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all hover:border-gray-600/50 cursor-pointer"
                              style={{
                                colorScheme: "dark",
                              }}
                            />
                          </div>

                          {/* End Date */}
                          <div className="space-y-3">
                            <label className="text-sm font-medium flex items-center gap-2 text-gray-300">
                              <CalendarIcon className="h-5 w-5" />
                              End Date
                            </label>
                            <input
                              type="date"
                              value={schedulingEndDate ? format(schedulingEndDate, "yyyy-MM-dd") : ""}
                              onChange={(e) => {
                                const date = e.target.value ? new Date(e.target.value) : null;
                                setSchedulingEndDate(date);
                              }}
                              min={schedulingStartDate ? format(schedulingStartDate, "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd")}
                              className="w-full px-6 py-4 bg-gray-800/60 border-2 border-gray-700/50 rounded-xl text-white text-lg font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all hover:border-gray-600/50 cursor-pointer"
                              style={{
                                colorScheme: "dark",
                              }}
                            />
                          </div>
                        </div>

                        {/* Period Summary */}
                        {schedulingStartDate && schedulingEndDate && (
                          <div className="p-5 bg-gray-800/40 rounded-xl border border-gray-700/30">
                            <p className="text-sm text-gray-400 mb-2">
                              Selected Period:
                            </p>
                            <p className="text-white font-semibold text-lg">
                              {format(schedulingStartDate, "MMM dd, yyyy")} →{" "}
                              {format(schedulingEndDate, "MMM dd, yyyy")}
                            </p>
                            <p className="text-sm text-gray-400 mt-2">
                              Duration: ~
                              {Math.round(
                                differenceInDays(
                                  schedulingEndDate,
                                  schedulingStartDate
                                ) / 30
                              )}{" "}
                              month(s)
                            </p>
                          </div>
                        )}

                        {/* Validation Message */}
                        {!validation.valid && validation.message && (
                          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                            <p className="text-sm text-red-400">
                              {validation.message}
                            </p>
                          </div>
                        )}

                        {/* Info Message */}
                        <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                          <p className="text-sm text-blue-300">
                            💡 Timezone: {timezone} (Your local time)
                          </p>
                        </div>
                      </div>
                      <div className="bg-gray-800/50 px-6 py-4 flex justify-end gap-3 rounded-b-lg">
                        <Button
                          variant="ghost"
                          onClick={() => setIsDialogOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleContinueToCheckout}
                          disabled={!validation.valid}
                          className="bg-white text-black hover:bg-gray-100"
                        >
                          Continue to Checkout
                        </Button>
                      </div>
                    </DialogContent>
                    </DialogPortal>
                  </Dialog>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </Tabs>
  );
}
