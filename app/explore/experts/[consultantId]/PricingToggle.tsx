import { CalendarIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { ClockIcon } from "lucide-react";
import { useState } from 'react';

interface PricingOption {
  title: string
  description: string
  price: number
  duration?: string
  features?: string[]
}

interface PricingToggleProps {
  consultationOptions?: PricingOption[]
  subscriptionOptions?: PricingOption[]
  consultantDetails: any
  userDetails: any
  handleBooking: () => void
  selectedDate: Date | null
  setSelectedDate: (date: Date | null) => void
  currentDate: Date
  setCurrentDate: (date: Date) => void
  renderCalendar: () => JSX.Element[]
  slotTimings: any[]
  selectedSlot: any
  setSelectedSlot: (slot: any) => void
}

const defaultConsultationOptions: PricingOption[] = [
  { title: "One Hour", description: "Get a quick consultation", price: 99, duration: "1 hour" },
  { title: "Two Hour", description: "Dive deeper into your needs", price: 199, duration: "2 hours" },
  { title: "Three Hour", description: "Comprehensive consultation", price: 299, duration: "3 hours" }
]

const defaultSubscriptionOptions: PricingOption[] = [
  {
    title: "One Month Subscription",
    description: "Get access to our full suite of services for one month.",
    price: 49,
    duration: "1 month",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources"
    ]
  },
  {
    title: "Three Month Subscription",
    description: "Get access to our full suite of services for three months.",
    price: 129,
    duration: "3 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "10% discount on all services"
    ]
  },
  {
    title: "Six Month Subscription",
    description: "Get access to our full suite of services for six months.",
    price: 249,
    duration: "6 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "15% discount on all services"
    ]
  }
]

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
  setSelectedSlot
}: PricingToggleProps) {
  const [activeTab, setActiveTab] = useState("consultation")
  const [activeConsultationOption, setActiveConsultationOption] = useState(consultationOptions[0].title.toLowerCase().replace(" ", "-"))
  const [activeSubscriptionOption, setActiveSubscriptionOption] = useState(subscriptionOptions[0].title.toLowerCase().replace(" ", "-"))

  return (
    <div className="w-full max-w-4xl mx-auto py-16 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-gray-900 to-black rounded-3xl shadow-2xl">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
        <TabsList className="flex justify-center gap-4 bg-gray-800/50 rounded-full p-1 backdrop-blur-sm">
          <TabsTrigger
            value="consultation"
            className={`${activeTab === 'consultation' ? 'bg-gray-200 text-black' : 'text-gray-300'} px-6 py-3 rounded-full transition-all duration-300 ease-in-out`}
          >
            Consultation
          </TabsTrigger>
          <TabsTrigger
            value="subscription"
            className={`${activeTab === 'subscription' ? 'bg-gray-200 text-black' : 'text-gray-300'} px-6 py-3 rounded-full transition-all duration-300 ease-in-out`}
          >
            Subscription
          </TabsTrigger>
        </TabsList>
        <TabsContent value="consultation">
          <Tabs value={activeConsultationOption} onValueChange={setActiveConsultationOption} className="space-y-8">
            <TabsList className="flex justify-center gap-4 bg-gray-800/50 rounded-full p-1 backdrop-blur-sm">
              {consultationOptions.map((option) => (
                <TabsTrigger
                  key={option.title}
                  value={option.title.toLowerCase().replace(" ", "-")}
                  className={`${activeConsultationOption === option.title.toLowerCase().replace(" ", "-") ? 'bg-gray-200 text-black' : 'text-gray-300'} px-6 py-3 rounded-full transition-all duration-300 ease-in-out`}
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
                  animate={{ opacity: activeConsultationOption === option.title.toLowerCase().replace(" ", "-") ? 1 : 0, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={activeConsultationOption === option.title.toLowerCase().replace(" ", "-") ? 'block' : 'hidden'}
                >
                  <Card className="bg-gray-800/50 border-gray-700 shadow-lg hover:shadow-xl transition-all duration-300 backdrop-blur-sm">
                    <CardHeader>
                      <CardTitle className="text-2xl font-bold text-gray-100">{option.title}</CardTitle>
                      <CardDescription className="text-gray-400">{option.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="text-5xl font-bold text-gray-100">${option.price}</div>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" className="w-full bg-gray-200 text-black hover:bg-gray-300 transition-colors duration-300">
                            Book Now
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-[425px] lg:max-w-[700px] bg-gray-900 text-gray-100 p-0 border border-gray-700 rounded-lg">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
                            <div>
                              <h3 className="text-xl font-semibold mb-4 flex items-center"><CalendarIcon className="mr-2" /> Select a Date</h3>
                              <div className="calendar-container bg-gray-800 p-4 rounded-lg border border-gray-700">
                                <div className="flex justify-between items-center mb-4">
                                  <Button variant="ghost" onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))}>
                                    &lt;
                                  </Button>
                                  <span className="text-lg font-medium">
                                    {currentDate.toLocaleString("default", {
                                      month: "long",
                                      year: "numeric",
                                    })}
                                  </span>
                                  <Button variant="ghost" onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))}>
                                    &gt;
                                  </Button>
                                </div>
                                <div className="grid grid-cols-7 gap-2 text-center">
                                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                                    <div key={day} className="text-sm font-medium text-gray-400">
                                      {day}
                                    </div>
                                  ))}
                                  {renderCalendar()}
                                </div>
                              </div>
                            </div>
                            <div>
                              <h3 className="text-xl font-semibold mb-4 flex items-center"><ClockIcon className="mr-2" /> Available Time Slots</h3>
                              <div className="bg-gray-800 p-4 rounded-lg border border-gray-700">
                                {slotTimings.length > 0 ? (
                                  <div className="grid grid-cols-2 gap-2">
                                    {slotTimings.map((slot) => (
                                      <Button
                                        key={slot.slotId}
                                        variant={selectedSlot?.slotId === slot.slotId ? "secondary" : "outline"}
                                        onClick={() => setSelectedSlot(slot)}
                                        className="w-full justify-center text-sm"
                                      >
                                        {slot.localStartTime} - {slot.localEndTime}
                                      </Button>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-center text-gray-400">No available slots. Please select a date to refresh.</p>
                                )}
                              </div>
                            </div>
                          </div>
                          <DialogFooter className="p-6 bg-gray-800 rounded-b-lg">
                            <Button
                              variant="outline"
                              onClick={() => {
                                /* handle cancel */
                              }}
                              className="text-gray-300 border-gray-600 hover:bg-gray-700"
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="default"
                              onClick={handleBooking}
                              disabled={!selectedDate || !selectedSlot}
                              className="bg-gray-200 text-black hover:bg-gray-300"
                            >
                              Book Consultation
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </Tabs>
        </TabsContent>
        <TabsContent value="subscription">
          <Tabs value={activeSubscriptionOption} onValueChange={setActiveSubscriptionOption} className="space-y-8">
            <TabsList className="flex justify-center gap-4 bg-gray-800/50 rounded-full p-1 backdrop-blur-sm">
              {subscriptionOptions.map((option) => (
                <TabsTrigger
                  key={option.title}
                  value={option.title.toLowerCase().replace(" ", "-")}
                  className={`${activeSubscriptionOption === option.title.toLowerCase().replace(" ", "-") ? 'bg-gray-200 text-black' : 'text-gray-300'} px-6 py-3 rounded-full transition-all duration-300 ease-in-out`}
                >
                  {option.title.split(' ')[0]} {option.title.split(' ')[1]}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="grid grid-cols-1 gap-6">
              {subscriptionOptions.map((option) => (
                <motion.div
                  key={option.title}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: activeSubscriptionOption === option.title.toLowerCase().replace(" ", "-") ? 1 : 0, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={activeSubscriptionOption === option.title.toLowerCase().replace(" ", "-") ? 'block' : 'hidden'}
                >
                  <Card className="bg-gray-800/50 border-gray-700 shadow-lg hover:shadow-xl transition-all duration-300 backdrop-blur-sm">
                    <CardHeader>
                      <CardTitle className="text-2xl font-bold text-gray-100">{option.title}</CardTitle>
                      <CardDescription className="text-gray-400">{option.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="text-5xl font-bold text-gray-100">${option.price}<span className="text-xl text-gray-400">/{option.duration}</span></div>
                      <div className="space-y-2">
                        <p className="text-gray-300">Includes:</p>
                        <ul className="space-y-1 pl-4">
                          {option.features?.map((feature, index) => (
                            <li key={index} className="text-gray-400 flex items-center">
                              <svg className="w-4 h-4 mr-2 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                              {feature}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" className="w-full bg-gray-200 text-black hover:bg-gray-300 transition-colors duration-300">
                            Subscribe
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-[425px] bg-gray-900 text-gray-100 border border-gray-700">
                          <DialogHeader>
                            <DialogTitle>Confirm Subscription</DialogTitle>
                            <DialogDescription className="text-gray-400">
                              Are you sure you want to subscribe to this plan?
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <Button variant="outline" onClick={() => { }} className="text-gray-300 border-gray-600 hover:bg-gray-700">Cancel</Button>
                            <Button variant="default" onClick={() => { }} className="bg-gray-200 text-black hover:bg-gray-300">Confirm Subscription</Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  )
}