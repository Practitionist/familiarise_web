"use client";

import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEvents } from "@/hooks/useEvents";
import { Overview } from "../components/Overview";
import { Calendar } from "../components/Calendar";
import { Upcoming } from "../components/Upcoming";

export default function AppointmentsTab({
  consulteeId,
}: {
  consulteeId: string;
}) {
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
    return <div>No appointments found</div>;
  }

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)]">
      <h2 className="text-3xl font-bold">Consultee Appointments</h2>
      <Tabs defaultValue="overview" className="space-y-8">
        <TabsList className="grid w-full grid-cols-3 lg:w-[400px] rounded-lg overflow-hidden">
          <TabsTrigger
            value="overview"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-l border-b rounded-tl-lg rounded-bl-lg"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="upcoming"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-b"
          >
            Upcoming
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
        <TabsContent value="upcoming" className="space-y-8 rounded-lg">
          <Upcoming
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
