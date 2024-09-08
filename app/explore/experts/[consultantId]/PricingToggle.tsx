import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { StarIcon } from "lucide-react"

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
  consultantDetails,
  userDetails,
  handleBooking,
  selectedDate,
  setSelectedDate,
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
    <div className="w-full max-w-3xl mx-auto py-12">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="flex justify-center gap-4 border border-gray-200 rounded-lg p-1">
          <TabsTrigger
            value="consultation"
            className={`${activeTab === 'consultation' ? 'bg-black text-white' : ''} px-4 py-2 rounded-md transition-colors duration-200`}
          >
            Consultation
          </TabsTrigger>
          <TabsTrigger
            value="subscription"
            className={`${activeTab === 'subscription' ? 'bg-black text-white' : ''} px-4 py-2 rounded-md transition-colors duration-200`}
          >
            Subscription
          </TabsTrigger>
        </TabsList>
        <TabsContent value="consultation">
          <Tabs value={activeConsultationOption} onValueChange={setActiveConsultationOption} className="space-y-6">
            <TabsList className="flex justify-center gap-4 border border-gray-200 rounded-lg p-1">
              {consultationOptions.map((option) => (
                <TabsTrigger
                  key={option.title}
                  value={option.title.toLowerCase().replace(" ", "-")}
                  className={`${activeConsultationOption === option.title.toLowerCase().replace(" ", "-") ? 'bg-black text-white' : ''} px-4 py-2 rounded-md transition-colors duration-200`}
                >
                  {option.title}
                </TabsTrigger>
              ))}
            </TabsList>
            {consultationOptions.map((option) => (
              <TabsContent key={option.title} value={option.title.toLowerCase().replace(" ", "-")}>
                <Card className="border border-gray-200 shadow-sm hover:shadow-md transition-shadow duration-200">
                  <CardHeader>
                    <CardTitle>{option.title}</CardTitle>
                    <CardDescription>{option.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="text-4xl font-bold">${option.price}</div>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline" className="w-full cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white border border-black">
                          Book Now
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="sm:max-w-[425px] lg:max-w-[700px] bg-black bg-opacity-80 text-white p-0 border border-white rounded-lg">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                          <div>
                            <h3 className="text-lg font-semibold mb-4">Select a Date</h3>
                            <div className="calendar-container bg-white bg-opacity-10 p-4 rounded-lg border border-white">
                              <div className="flex justify-between items-center mb-4">
                                <button className="text-white" onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))}>
                                  &lt;
                                </button>
                                <span>
                                  {currentDate.toLocaleString("default", {
                                    month: "long",
                                    year: "numeric",
                                  })}
                                </span>
                                <button className="text-white" onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))}>
                                  &gt;
                                </button>
                              </div>
                              <div className="grid grid-cols-7 gap-1 text-center">
                                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                                  <div key={day} className="text-sm font-medium">
                                    {day}
                                  </div>
                                ))}
                                {renderCalendar()}
                              </div>
                            </div>
                          </div>
                          <div>
                            <h3 className="text-lg font-semibold mb-4">Available Time Slots</h3>
                            <div className="bg-white bg-opacity-10 p-4 rounded-lg border border-white">
                              {slotTimings.length > 0 ? (
                                <div className="space-y-2">
                                  {slotTimings.map((slot) => (
                                    <Button
                                      key={slot.slotId}
                                      variant={selectedSlot?.slotId === slot.slotId ? "outline" : "night"}
                                      onClick={() => setSelectedSlot(slot)}
                                      className="w-full justify-center text-sm bg-black bg-opacity-80 hover:bg-opacity-100 border border-white"
                                    >
                                      {slot.localStartTime} - {slot.localEndTime}
                                    </Button>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-center">No available slots. Please select a date to refresh.</p>
                              )}
                            </div>
                          </div>
                        </div>
                        <DialogFooter className="p-4 bg-transparent">
                          <Button
                            variant="outline"
                            onClick={() => {
                              /* handle cancel */
                            }}
                            className="text-white border-white"
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="night"
                            onClick={handleBooking}
                            disabled={!selectedDate || !selectedSlot}
                            className="border border-white"
                          >
                            Book Consultation
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        </TabsContent>
        <TabsContent value="subscription">
          <Tabs value={activeSubscriptionOption} onValueChange={setActiveSubscriptionOption} className="space-y-6">
            <TabsList className="flex justify-center gap-4 border border-gray-200 rounded-lg p-1">
              {subscriptionOptions.map((option) => (
                <TabsTrigger
                  key={option.title}
                  value={option.title.toLowerCase().replace(" ", "-")}
                  className={`${activeSubscriptionOption === option.title.toLowerCase().replace(" ", "-") ? 'bg-black text-white' : ''} px-4 py-2 rounded-md transition-colors duration-200`}
                >
                  {option.title.split(' ')[0]} {option.title.split(' ')[1]}
                </TabsTrigger>
              ))}
            </TabsList>
            {subscriptionOptions.map((option) => (
              <TabsContent key={option.title} value={option.title.toLowerCase().replace(" ", "-")}>
                <Card className="border border-gray-200 shadow-sm hover:shadow-md transition-shadow duration-200">
                  <CardHeader>
                    <CardTitle>{option.title}</CardTitle>
                    <CardDescription>{option.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="text-4xl font-bold">${option.price}/{option.duration}</div>
                    <div className="space-y-2">
                      <p>Includes:</p>
                      <ul className="list-disc space-y-1 pl-4">
                        {option.features?.map((feature, index) => (
                          <li key={index}>{feature}</li>
                        ))}
                      </ul>
                    </div>
                    <Button variant="outline" className="w-full border border-black hover:bg-black hover:text-white transition-colors duration-200">
                      Subscribe
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  )
}