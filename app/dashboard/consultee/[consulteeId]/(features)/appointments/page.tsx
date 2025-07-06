"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";
import { useConsulteeEvents } from "../../hooks/useConsulteeEvents";
import { Overview } from "./Overview";
import { Calendar } from "./Calendar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function AppointmentsPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);
  const { data: eventsData, isLoading, error } = useConsulteeEvents(consulteeId);

  if (isLoading) {
    return <DashboardHomeSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Appointments</h3>
            <p className="text-sm">
              {error.message || "Failed to load appointments. Please try again."}
            </p>
            <button 
              onClick={() => window.location.reload()} 
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  const { consultations = [], subscriptions = [], webinars = [], classes = [] } = eventsData || {};

  if (!consultations.length && !subscriptions.length && !webinars.length && !classes.length) {
    return (
      <DashboardErrorBoundary>
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
                strokeWidth={1}
                d="M8 7V3a1 1 0 011-1h6a1 1 0 011 1v4h3a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1V8a1 1 0 011-1h3z"
              />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-gray-900 mb-2">
            No Appointments Found
          </h3>
          <p className="text-gray-500 text-center">
            You don't have any appointments scheduled yet. Book your first session to get started!
          </p>
        </motion.div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
        </TabsList>
        
        <TabsContent value="overview">
          <Overview
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
          />
        </TabsContent>
        
        <TabsContent value="calendar">
          <Calendar
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
          />
        </TabsContent>
      </Tabs>
    </DashboardErrorBoundary>
  );
}
