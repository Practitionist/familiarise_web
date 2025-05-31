"use client";

import React, { Suspense } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
// Export ProcessStep for use in flow components
export { ProcessStep } from "./flows/ProcessStep";

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

// ProcessStep is now imported from ./ProcessStep

// Type definitions for dynamically imported components
type FlowComponentProps = object;
type FlowComponent = React.ComponentType<FlowComponentProps>;

// Dynamically import flow components to reduce initial bundle size
const ConsultationFlow = dynamic<FlowComponentProps>(
  async () => {
    const module = await import("./flows/ConsultationFlow");
    return module.default as FlowComponent;
  },
  {
    loading: () => <LoadingFallback />,
    ssr: true,
  },
);

const SubscriptionFlow = dynamic<FlowComponentProps>(
  async () => {
    const module = await import("./flows/SubscriptionFlow");
    return module.default as FlowComponent;
  },
  {
    loading: () => <LoadingFallback />,
    ssr: true,
  },
);

const WebinarFlow = dynamic<FlowComponentProps>(
  async () => {
    const module = await import("./flows/WebinarFlow");
    return module.default as FlowComponent;
  },
  {
    loading: () => <LoadingFallback />,
    ssr: true,
  },
);

const ClassFlow = dynamic<FlowComponentProps>(
  async () => {
    const module = await import("./flows/ClassFlow");
    return module.default as FlowComponent;
  },
  {
    loading: () => <LoadingFallback />,
    ssr: true,
  },
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
            <Suspense fallback={<LoadingFallback />}>
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
            </Suspense>
          </div>
        </Tabs>
      </Card>
    </section>
  );
}
