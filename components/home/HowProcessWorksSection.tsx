"use client";

import React from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ProcessStep = ({
  number,
  title,
  description,
  isLast = false,
}: {
  number: number;
  title: string;
  description: string;
  isLast?: boolean;
}) => (
  <div className="relative">
    <motion.div
      className="flex gap-4 items-start relative z-10 group hover:bg-accent/50 p-4 rounded-lg transition-all duration-300"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      whileHover={{ x: 4 }}
    >
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary/80 text-white flex items-center justify-center shadow-md font-medium">
        {number}
      </div>
      <div>
        <h4 className="font-semibold text-lg group-hover:text-primary transition-colors">
          {title}
        </h4>
        <p className="text-muted-foreground group-hover:text-foreground/80 transition-colors">
          {description}
        </p>
      </div>
    </motion.div>
    {!isLast && (
      <div className="absolute left-9 top-14 w-[2px] h-[calc(100%-0.5rem)] bg-gradient-to-b from-primary/30 to-transparent" />
    )}
  </div>
);

const ConsultationFlow = () => (
  <div className="space-y-6">
    <ProcessStep
      number={1}
      title="Select a Consultation Plan"
      description="Browse and choose from various consultation plans offered by experts"
    />
    <ProcessStep
      number={2}
      title="Create Consultation Request"
      description="Submit your request with preferred time slots and specific requirements"
    />
    <ProcessStep
      number={3}
      title="Schedule Appointment"
      description="Once approved, an appointment is created for your consultation"
    />
    <ProcessStep
      number={4}
      title="Complete Payment"
      description="Secure your booking by completing the payment process"
    />
    <ProcessStep
      number={5}
      title="Join Consultation"
      description="Access your consultation at the scheduled time through our platform"
      isLast={true}
    />
  </div>
);

const SubscriptionFlow = () => (
  <div className="space-y-6">
    <ProcessStep
      number={1}
      title="Choose Subscription Plan"
      description="Select from monthly subscription plans with different benefits"
    />
    <ProcessStep
      number={2}
      title="Submit Subscription Request"
      description="Provide your preferred schedule and learning goals"
    />
    <ProcessStep
      number={3}
      title="Schedule Multiple Sessions"
      description="Get access to multiple appointments throughout your subscription period"
    />
    <ProcessStep
      number={4}
      title="One-time Payment"
      description="Make a single payment to activate your subscription"
    />
    <ProcessStep
      number={5}
      title="Access All Benefits"
      description="Enjoy regular sessions and additional subscription benefits"
      isLast={true}
    />
  </div>
);

const WebinarFlow = () => (
  <div className="space-y-6">
    <ProcessStep
      number={1}
      title="Select Webinar"
      description="Choose from upcoming webinars on various topics"
    />
    <ProcessStep
      number={2}
      title="Check Availability"
      description="View scheduled dates and remaining spots"
    />
    <ProcessStep
      number={3}
      title="Book Your Spot"
      description="Reserve your place in the webinar"
    />
    <ProcessStep
      number={4}
      title="Complete Payment"
      description="Secure your spot by completing the payment"
    />
    <ProcessStep
      number={5}
      title="Join Webinar"
      description="Get access to the webinar at the scheduled time"
      isLast={true}
    />
  </div>
);

const ClassFlow = () => (
  <div className="space-y-6">
    <ProcessStep
      number={1}
      title="Choose Class Plan"
      description="Browse structured class programs with detailed curricula"
    />
    <ProcessStep
      number={2}
      title="Check Class Schedule"
      description="View class timings and batch availability"
    />
    <ProcessStep
      number={3}
      title="Secure Your Seat"
      description="Book your place in the upcoming batch"
    />
    <ProcessStep
      number={4}
      title="Complete Payment"
      description="Process payment to confirm your enrollment"
    />
    <ProcessStep
      number={5}
      title="Start Learning"
      description="Access class materials and attend scheduled sessions"
      isLast={true}
    />
  </div>
);

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
            <TabsContent value="consultation">
              <ConsultationFlow />
            </TabsContent>
            <TabsContent value="subscription">
              <SubscriptionFlow />
            </TabsContent>
            <TabsContent value="webinar">
              <WebinarFlow />
            </TabsContent>
            <TabsContent value="class">
              <ClassFlow />
            </TabsContent>
          </div>
        </Tabs>
      </Card>
    </section>
  );
}
