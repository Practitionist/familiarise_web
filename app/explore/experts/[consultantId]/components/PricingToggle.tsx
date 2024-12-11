import { CalendarIcon } from "@/assets/icons";
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
  DialogTrigger
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { ClockIcon } from "lucide-react";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { PricingOption, defaultConsultationOptions, defaultSubscriptionOptions } from "../defaults";

interface PricingToggleProps {
  consultationOptions?: PricingOption[];
  subscriptionOptions?: PricingOption[];
  consultantDetails: any;
  userDetails: any;
  handleBooking: () => void;
  selectedDate: Date | null;
  setSelectedDate: (date: Date | null) => void;
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  renderCalendar: () => JSX.Element[];
  slotTimings: any[];
  selectedSlot: any;
  setSelectedSlot: (slot: any) => void;
}

const formatTime = (isoString: string): string => {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      throw new Error("Invalid date");
    }
    
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    
    hours = hours % 12;
    hours = hours ? hours : 12;
    
    const minutesStr = minutes < 10 ? '0' + minutes : minutes;
    
    return `${hours}:${minutesStr} ${ampm}`;
  } catch (error) {
    console.error("Error formatting time:", error);
    return "Invalid Time";
  }
};

export default function PricingToggle({
  consultationOptions = defaultConsultationOptions,
  subscriptionOptions = defaultSubscriptionOptions,
  handleBooking,
  selectedDate,
  currentDate,
  setCurrentDate,
  renderCalendar,
  slotTimings,
  selectedSlot,
  setSelectedSlot,
}: Readonly<PricingToggleProps>) {
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState("consultation");
  const [activeConsultationOption, setActiveConsultationOption] = useState(
    consultationOptions.length > 0
      ? consultationOptions[0].title.toLowerCase().replace(" ", "-")
      : defaultConsultationOptions[0].title.toLowerCase().replace(" ", "-"),
  );
  const [activeSubscriptionOption, setActiveSubscriptionOption] = useState(
    subscriptionOptions.length > 0
      ? subscriptionOptions[0].title.toLowerCase().replace(" ", "-")
      : defaultSubscriptionOptions[0].title.toLowerCase().replace(" ", "-"),
  );

  // Sort slot timings by start time
  const sortedSlotTimings = useMemo(() => {
    if (!selectedDate || !slotTimings.length) return [];

    const selectedDay = selectedDate.getDay();
    
    return slotTimings
      .filter(slot => {
        const slotDate = new Date(slot.slotStartTimeInUTC);
        return slotDate.getDay() === selectedDay;
      })
      .sort((a, b) => {
        const dateA = new Date(a.slotStartTimeInUTC);
        const dateB = new Date(b.slotStartTimeInUTC);
        return dateA.getTime() - dateB.getTime();
      });
  }, [slotTimings, selectedDate]);

  if (consultationOptions.length === 0 && subscriptionOptions.length === 0) {
    return (
      <div className="w-full max-w-4xl mx-auto py-16 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
        <div className="text-center text-gray-300">
          <p>No pricing options available at the moment.</p>
        </div>
      </div>
    );
  }

  if (session?.user?.role && ["consultant", "staff"].includes(session.user.role.toLowerCase())) {
    return (
      <div className="w-full max-w-4xl mx-auto py-16 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
        <div className="text-center text-gray-300 space-y-3">
          <h3 className="text-2xl font-medium tracking-tight">
            Consultee Access Required
          </h3>
          <p className="text-gray-400">
            To book consultations or subscribe to services, please sign in with
            a consultee account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto py-16 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-8"
      >
        <TabsList className="flex justify-center gap-4 bg-gray-800/50 rounded-full p-1 backdrop-blur-sm">
          {consultationOptions.length > 0 && (
            <TabsTrigger
              value="consultation"
              className={`${activeTab === "consultation" ? "bg-white text-black" : "text-white"} px-6 py-3 rounded-full transition-all duration-300 ease-in-out hover:bg-white/10`}
            >
              Consultation
            </TabsTrigger>
          )}
          {subscriptionOptions.length > 0 && (
            <TabsTrigger
              value="subscription"
              className={`${activeTab === "subscription" ? "bg-white text-black" : "text-white"} px-6 py-3 rounded-full transition-all duration-300 ease-in-out hover:bg-white/10`}
            >
              Subscription
            </TabsTrigger>
          )}
        </TabsList>

        {consultationOptions.length > 0 && (
          <TabsContent value="consultation">
            <Tabs
              value={activeConsultationOption}
              onValueChange={setActiveConsultationOption}
              className="space-y-8"
            >
              <TabsList className="flex justify-center gap-4 bg-gray-800/50 rounded-full p-1 backdrop-blur-sm">
                {consultationOptions.map((option) => (
                  <TabsTrigger
                    key={option.title}
                    value={option.title.toLowerCase().replace(" ", "-")}
                    className={`${activeConsultationOption === option.title.toLowerCase().replace(" ", "-") ? "bg-white text-black" : "text-white"} px-6 py-3 rounded-full transition-all duration-300 ease-in-out hover:bg-white/10`}
                  >
                    {option.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="grid grid-cols-1 gap-6">
                {consultationOptions.map((option) => (
                  <motion.div
                    key={option.title}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{
                      opacity:
                        activeConsultationOption ===
                        option.title.toLowerCase().replace(" ", "-")
                          ? 1
                          : 0,
                      y: 0,
                    }}
                    transition={{ duration: 0.3 }}
                    className={
                      activeConsultationOption ===
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
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="outline"
                              className="w-full bg-white text-black hover:bg-gray-100 transition-colors duration-300"
                            >
                              Book Now
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="sm:max-w-[425px] lg:max-w-[700px] bg-[#15171B] text-white p-0 border-0 rounded-lg">
                            <DialogHeader className="p-6 border-b border-gray-800">
                              <DialogTitle>Book Consultation</DialogTitle>
                            </DialogHeader>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
                              {/* Calendar Section */}
                              <div>
                                <h3 className="text-lg font-semibold mb-4 flex items-center">
                                  <CalendarIcon className="mr-2 h-5 w-5" /> Select a Date
                                </h3>
                                <div className="calendar-container bg-gray-800/60 p-4 rounded-lg">
                                  <div className="flex justify-between items-center mb-4">
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        setCurrentDate(
                                          new Date(
                                            currentDate.getFullYear(),
                                            currentDate.getMonth() - 1,
                                            1,
                                          ),
                                        )
                                      }
                                      className="text-white hover:text-gray-300"
                                    >
                                      &lt;
                                    </Button>
                                    <span className="text-lg font-medium">
                                      {currentDate.toLocaleString("default", {
                                        month: "long",
                                        year: "numeric",
                                      })}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        setCurrentDate(
                                          new Date(
                                            currentDate.getFullYear(),
                                            currentDate.getMonth() + 1,
                                            1,
                                          ),
                                        )
                                      }
                                      className="text-white hover:text-gray-300"
                                    >
                                      &gt;
                                    </Button>
                                  </div>
                                  <div className="grid grid-cols-7 gap-2 text-center">
                                    {[
                                      "Su",
                                      "Mo",
                                      "Tu",
                                      "We",
                                      "Th",
                                      "Fr",
                                      "Sa",
                                    ].map((day) => (
                                      <div
                                        key={`header-${day}`}
                                        className="text-sm font-medium text-gray-400"
                                      >
                                        {day}
                                      </div>
                                    ))}
                                    {renderCalendar()}
                                  </div>
                                </div>
                              </div>

                              {/* Time Slots Section */}
                              <div>
                                <h3 className="text-lg font-semibold mb-4 flex items-center">
                                  <ClockIcon className="mr-2 h-5 w-5" /> Available Time Slots
                                </h3>
                                <div className="bg-gray-800/60 p-4 rounded-lg h-[400px] overflow-y-auto">
                                  {sortedSlotTimings.length > 0 ? (
                                    <div className="grid grid-cols-1 gap-2">
                                      {sortedSlotTimings.map((slot) => {
                                        const startTime = formatTime(
                                          slot.slotStartTimeInUTC,
                                        );
                                        const endTime = formatTime(
                                          slot.slotEndTimeInUTC,
                                        );

                                        return (
                                          <Button
                                            key={`slot-${slot.slotId}`}
                                            variant={
                                              selectedSlot?.slotId ===
                                              slot.slotId
                                                ? "secondary"
                                                : "outline"
                                            }
                                            onClick={() =>
                                              setSelectedSlot(slot)
                                            }
                                            className={`w-full justify-center text-sm py-3 ${
                                              selectedSlot?.slotId ===
                                              slot.slotId
                                                ? "bg-gray-700 text-white border-gray-600"
                                                : "bg-gray-800 text-white border-gray-700 hover:bg-gray-700/50"
                                            }`}
                                          >
                                            {startTime} - {endTime}
                                          </Button>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div className="flex flex-col items-center justify-center h-full text-center">
                                      <ClockIcon className="w-12 h-12 text-gray-500 mb-2" />
                                      <p className="text-gray-400">
                                        No available slots for this date.
                                        <br />
                                        Please select a different date.
                                      </p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex justify-end gap-3 p-6 bg-gray-800/60">
                              <DialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="text-white border-gray-700 hover:bg-gray-700/50"
                                >
                                  Cancel
                                </Button>
                              </DialogTrigger>
                              <Button
                                variant="default"
                                onClick={handleBooking}
                                disabled={!selectedDate || !selectedSlot}
                                className="bg-white text-black hover:bg-gray-100"
                              >
                                Book Consultation
                              </Button>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </Tabs>
          </TabsContent>
        )}

        {subscriptionOptions.length > 0 && (
          <TabsContent value="subscription">
            <Tabs
              value={activeSubscriptionOption}
              onValueChange={setActiveSubscriptionOption}
              className="space-y-8"
            >
              <TabsList className="flex justify-center gap-4 bg-gray-800/50 rounded-full p-1 backdrop-blur-sm">
                {subscriptionOptions.map((option) => (
                  <TabsTrigger
                    key={option.title}
                    value={option.title.toLowerCase().replace(" ", "-")}
                    className={`${activeSubscriptionOption === option.title.toLowerCase().replace(" ", "-") ? "bg-white text-black" : "text-white"} px-6 py-3 rounded-full transition-all duration-300 ease-in-out hover:bg-white/10`}
                  >
                    {option.title.split(" ")[0]} {option.title.split(" ")[1]}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="grid grid-cols-1 gap-6">
                {subscriptionOptions.map((option) => (
                  <motion.div
                    key={option.title}
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
                          <span className="text-xl text-gray-300">
                            /{option.duration}
                          </span>
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
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="outline"
                              className="w-full bg-white text-black hover:bg-gray-100 transition-colors duration-300"
                            >
                              Subscribe
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="sm:max-w-[425px] bg-[#15171B] text-white border-0">
                            <DialogHeader>
                              <DialogTitle>Confirm Subscription</DialogTitle>
                              <DialogDescription className="text-gray-300">
                                Are you sure you want to subscribe to this plan?
                              </DialogDescription>
                            </DialogHeader>
                            <div className="flex justify-end gap-3 mt-6">
                              <DialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="text-white border-gray-700 hover:bg-gray-700/50"
                                >
                                  Cancel
                                </Button>
                              </DialogTrigger>
                              <Button
                                variant="default"
                                className="bg-white text-black hover:bg-gray-100"
                              >
                                Confirm Subscription
                              </Button>
                            </div>
                          </DialogContent>
                        </Dialog>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </Tabs>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
