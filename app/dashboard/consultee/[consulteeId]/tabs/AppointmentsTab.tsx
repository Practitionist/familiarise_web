"use client";

import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEvents } from "@/hooks/useEvents";
import { Overview } from "../components/Overview";
import { Calendar } from "../components/Calendar";

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
      <div className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-gray-50 rounded-lg">
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
        <p className="text-gray-500 text-center">
          You don't have any appointments scheduled at the moment.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)]">
      <h2 className="text-3xl font-bold">Consultee Appointments</h2>
      <Tabs defaultValue="overview" className="space-y-8">
        <TabsList className="grid w-full grid-cols-2 lg:w-[400px] rounded-lg overflow-hidden">
          <TabsTrigger
            value="overview"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-l border-b rounded-tl-lg rounded-bl-lg"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="calendar"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-r border-b rounded-tr-lg rounded-br-lg"
          >
            Calendar
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-8 rounded-lg">
          <Overview
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
          />
        </TabsContent>
        <TabsContent value="calendar" className="space-y-8 rounded-lg">
          <Calendar
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
