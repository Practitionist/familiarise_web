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
  } = eventsData || {};

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <div className="w-full">
          <div className="flex items-center justify-center min-h-[500px]">
            <div className="text-center space-y-4">
              <div className="relative inline-flex">
                <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-200 border-t-blue-600"></div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-8 w-8 rounded-full bg-blue-100"></div>
                </div>
              </div>
              <div className="text-gray-700 text-base font-medium">
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
      <div className="min-h-screen">
        <div className="w-full">
          <div className="flex items-center justify-center min-h-[500px]">
            <div className="max-w-md w-full">
              <div className="bg-gradient-to-br from-red-50 to-red-100/50 border-2 border-red-200 rounded-2xl p-8 text-center shadow-xl">
                <div className="w-16 h-16 bg-gradient-to-br from-red-500 to-red-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
                  <svg
                    className="w-8 h-8 text-white"
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
                <h3 className="text-xl font-bold text-red-900 mb-3">
                  Error Loading Appointments
                </h3>
                <p className="text-red-700 text-sm mb-6">
                  {error.message ||
                    "Failed to load appointments. Please try again."}
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="bg-gradient-to-r from-red-600 to-red-700 text-white px-6 py-3 rounded-lg text-sm font-bold hover:from-red-700 hover:to-red-800 transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-105"
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
    <div className="min-h-screen">
      <div className="w-full">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Tabs defaultValue="overview" className="w-full space-y-8">
            <div className="border-b border-gray-200 bg-white rounded-2xl shadow-lg overflow-hidden">
              <TabsList className="h-auto p-0 bg-transparent w-full justify-start">
                <TabsTrigger
                  value="overview"
                  className="px-8 py-5 text-sm font-semibold border-b-3 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600 data-[state=active]:bg-blue-50/30 bg-transparent rounded-none transition-all duration-200"
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger
                  value="calendar"
                  className="px-8 py-5 text-sm font-semibold border-b-3 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600 data-[state=active]:bg-blue-50/30 bg-transparent rounded-none transition-all duration-200"
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
                />
              </motion.div>
            </TabsContent>
          </Tabs>
        </motion.div>
      </div>
    </div>
  );
}
