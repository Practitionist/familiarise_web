"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createConsulteeQueries } from "@/hooks/useConsulteePrefetchDashboard";
import { Overview } from "./Overview";
import { Calendar } from "./Calendar";
import { motion } from "framer-motion";

export default function AppointmentsTab({
  consulteeId,
}: Readonly<{
  consulteeId: string;
}>) {
  // Use the centralized query configuration
  const eventsQuery = createConsulteeQueries(consulteeId).events;
  const { data: eventsData, isLoading, error } = useQuery(eventsQuery);

  const {
    consultations = [],
    subscriptions = [],
    webinars = [],
    classes = [],
    trials = [],
  } = eventsData || {};

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center space-y-3">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <div className="text-gray-500 text-sm">
                Loading appointments...
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="max-w-md w-full">
              <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="w-6 h-6 text-red-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-red-900 mb-2">
                  Error Loading Appointments
                </h3>
                <p className="text-red-700 text-sm mb-4">
                  {error.message ||
                    "Failed to load appointments. Please try again."}
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Tabs defaultValue="overview" className="w-full space-y-6">
            <div className="border-b border-gray-200 bg-white rounded-t-lg">
              <TabsList className="h-auto p-0 bg-transparent w-full justify-start">
                <TabsTrigger
                  value="overview"
                  className="px-6 py-4 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 bg-transparent rounded-none"
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger
                  value="calendar"
                  className="px-6 py-4 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 bg-transparent rounded-none"
                >
                  Calendar View
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent
              value="overview"
              className="mt-0 border-0 p-0 focus-visible:ring-0"
            >
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
              >
                <Overview
                  consultations={consultations}
                  subscriptions={subscriptions}
                  webinars={webinars}
                  classes={classes}
                  trials={trials}
                />
              </motion.div>
            </TabsContent>

            <TabsContent
              value="calendar"
              className="mt-0 border-0 p-0 focus-visible:ring-0"
            >
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
              >
                <Calendar
                  consultations={consultations}
                  subscriptions={subscriptions}
                  webinars={webinars}
                  classes={classes}
                  trials={trials}
                />
              </motion.div>
            </TabsContent>
          </Tabs>
        </motion.div>
      </div>
    </div>
  );
}
