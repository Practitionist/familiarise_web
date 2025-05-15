"use client";

import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEvents } from "@/hooks/useEvents";
import { Overview } from "./Overview";
import { Calendar } from "./Calendar";
import { motion } from "framer-motion";

export default function AppointmentsTab({
  consulteeId,
}: Readonly<{
  consulteeId: string;
}>) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } =
    useEvents(consulteeId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-gray-500">
          Loading appointments...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-lg">
        Error loading appointments: {error.message}
      </div>
    );
  }

  if (
    !consultations.length &&
    !subscriptions.length &&
    !webinars.length &&
    !classes.length
  ) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-white rounded-xl shadow-sm"
      >
        <div className="w-16 h-16 mb-4 text-gray-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-gray-900 mb-2">
          No Appointments Found
        </h3>
        <p className="text-gray-500 text-center max-w-md">
          You don't have any appointments scheduled at the moment. Book a
          session to get started on your learning journey.
        </p>
      </motion.div>
    );
  }

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)]">
      <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100">
        <h2 className="text-3xl font-bold text-gray-900 mb-2">
          Consultee Appointments
        </h2>
        <p className="text-gray-600">
          Manage and track all your scheduled sessions
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <Tabs defaultValue="overview" className="w-full">
          <div className="px-6 pt-4 pb-0">
            <TabsList className="inline-flex h-auto items-center justify-center rounded-lg bg-transparent p-0">
              <TabsTrigger
                value="overview"
                className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[#f87171] data-[state=active]:text-white data-[state=active]:shadow-md data-[state=inactive]:text-gray-500 data-[state=inactive]:hover:bg-gray-100 data-[state=inactive]:hover:text-gray-700"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="calendar"
                className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[#f87171] data-[state=active]:text-white data-[state=active]:shadow-md data-[state=inactive]:text-gray-500 data-[state=inactive]:hover:bg-gray-100 data-[state=inactive]:hover:text-gray-700"
              >
                Calendar
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="p-6">
            <TabsContent value="overview" className="mt-0 space-y-6">
              <Overview
                consultations={consultations}
                subscriptions={subscriptions}
                webinars={webinars}
                classes={classes}
              />
            </TabsContent>
            <TabsContent value="calendar" className="mt-0">
              <Calendar
                consultations={consultations}
                subscriptions={subscriptions}
                webinars={webinars}
                classes={classes}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
