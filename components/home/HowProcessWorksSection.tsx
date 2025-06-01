"use client";

import React, { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { ProcessFlowDisplay, ProcessFlowStepProps } from "./flows/ProcessFlowDisplay"; // Updated import

// Loading fallback component
const LoadingFallback = () => (
  <div className="animate-pulse space-y-6">
    {[1, 2, 3, 4, 5].map((num) => (
      <div key={num} className="flex gap-4 items-start p-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-200"></div>
        <div className="flex-1">
          <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
          <div className="h-3 bg-gray-200 rounded w-full"></div>
        </div>
      </div>
    ))}
  </div>
);

// Data for the different flows
const flowData: Record<string, ProcessFlowStepProps[]> = {
  consultation: [
    { number: 1, title: "Select a Consultation Plan", description: "Browse and choose from various consultation plans offered by experts" },
    { number: 2, title: "Create Consultation Request", description: "Submit your request with preferred time slots and specific requirements" },
    { number: 3, title: "Schedule Appointment", description: "Once approved, an appointment is created for your consultation" },
    { number: 4, title: "Complete Payment", description: "Secure your booking by completing the payment process" },
    { number: 5, title: "Join Consultation", description: "Access your consultation at the scheduled time through our platform", isLast: true },
  ],
  subscription: [
    { number: 1, title: "Choose Subscription Plan", description: "Select from monthly subscription plans with different benefits" },
    { number: 2, title: "Submit Subscription Request", description: "Provide your preferred schedule and learning goals" },
    { number: 3, title: "Schedule Multiple Sessions", description: "Get access to multiple appointments throughout your subscription period" },
    { number: 4, title: "One-time Payment", description: "Make a single payment to activate your subscription" },
    { number: 5, title: "Access All Benefits", description: "Enjoy regular sessions and additional subscription benefits", isLast: true },
  ],
  webinar: [
    { number: 1, title: "Select Webinar", description: "Choose from upcoming webinars on various topics" },
    { number: 2, title: "Check Availability", description: "View scheduled dates and remaining spots" },
    { number: 3, title: "Book Your Spot", description: "Reserve your place in the webinar" },
    { number: 4, title: "Complete Payment", description: "Secure your spot by completing the payment" },
    { number: 5, title: "Join Webinar", description: "Get access to the webinar at the scheduled time", isLast: true },
  ],
  class: [
    { number: 1, title: "Choose Class Plan", description: "Browse structured class programs with detailed curricula" },
    { number: 2, title: "Check Class Schedule", description: "View class timings and batch availability" },
    { number: 3, title: "Secure Your Seat", description: "Book your place in the upcoming batch" },
    { number: 4, title: "Complete Payment", description: "Process payment to confirm your enrollment" },
    { number: 5, title: "Start Learning", description: "Access class materials and attend scheduled sessions", isLast: true },
  ],
};

export default function HowProcessWorksSection() {
  return (
    <section className="py-20 bg-gradient-to-b from-muted/50 via-muted/30 to-background">
      <motion.div
        className="text-center mb-16"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <h2 className="text-3xl font-bold mb-4">How The Process Works</h2>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Choose from our various learning formats and follow these simple steps
          to start your journey
        </p>
      </motion.div>

      <Card className="p-8 shadow-lg border-t-2 border-t-primary/50 max-w-5xl mx-auto">
        <Tabs defaultValue="consultation" className="w-full">
          <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 p-1 mb-2">
            <TabsTrigger value="consultation">Consultation</TabsTrigger>
            <TabsTrigger value="subscription">Subscription</TabsTrigger>
            <TabsTrigger value="webinar">Webinar</TabsTrigger>
            <TabsTrigger value="class">Class</TabsTrigger>
          </TabsList>
          <div className="mt-8">
            <Suspense fallback={<LoadingFallback />}>
              {Object.entries(flowData).map(([flowType, steps]) => (
                <TabsContent key={flowType} value={flowType}>
                  <div className="space-y-6">
                    {steps.map((step) => (
                      <ProcessFlowDisplay key={step.number} {...step} />
                    ))}
                  </div>
                </TabsContent>
              ))}
            </Suspense>
          </div>
        </Tabs>
      </Card>
    </section>
  );
}
