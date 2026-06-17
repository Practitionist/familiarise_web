"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { Overview } from "./Overview";
import { Calendar } from "./Calendar";
import { BookingHistoryTab } from "../history/BookingHistoryTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";

export default function AppointmentsPageClient({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  // B1-personal-retrofit: drive the events query off the URL ?orgScope=
  // so org-funded sessions surface here (e.g. deep-links from
  // /dashboard/organization/<orgId>/my-program "Join now"). Default is
  // personal — backwards-compatible with B2C users.
  // Land on the union view by default — for an org learner who books
  // both personally and through their org, the appointments page is
  // the one place they want the full picture without toggling.
  const { scope, setScope } = useOrgScope({ defaultForOrgMember: "all" });
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;
  const eventsQuery = createConsulteeQueries(consulteeId, orgScopeParam).events;
  // keepPreviousData: scope-filter changes show the previous list while the
  // new one loads instead of a skeleton flash (documents-page idiom, #346).
  const { data: eventsData, isLoading, error } = useQuery({
    ...eventsQuery,
    placeholderData: keepPreviousData,
  });

  const filterValue: OrgContextFilterValue =
    scope.kind === "personal"
      ? ORG_FILTER_PERSONAL
      : scope.kind === "all"
        ? ORG_FILTER_ALL
        : scope.orgId;
  const handleFilterChange = (next: OrgContextFilterValue) => {
    if (next === ORG_FILTER_PERSONAL) setScope({ kind: "personal" });
    else if (next === ORG_FILTER_ALL) setScope({ kind: "all" });
    else setScope({ kind: "org", orgId: next });
  };

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Appointments</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load appointments. Please try again."}
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

  const {
    consultations = [],
    subscriptions = [],
    webinars = [],
    classes = [],
    trials = [],
  } = eventsData || {};

  if (
    !consultations.length &&
    !subscriptions.length &&
    !webinars.length &&
    !classes.length &&
    !trials.length
  ) {
    return (
      <DashboardErrorBoundary>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-card rounded-xl shadow-sm"
        >
          <div className="w-16 h-16 mb-4 text-muted-foreground/70">
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
          <h3 className="text-fluid-2xl font-semibold tracking-tight text-foreground mb-2">
            No Appointments Found
          </h3>
          <p className="text-muted-foreground text-center">
            You don't have any appointments scheduled yet. Book your first
            session to get started!
          </p>
        </motion.div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <Tabs defaultValue="upcoming" className="space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="past">Past</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <OrgContextFilter
            value={filterValue}
            onChange={handleFilterChange}
          />
        </div>

        <TabsContent value="upcoming">
          <Overview
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
            trials={trials}
            mode="upcoming"
          />
        </TabsContent>

        <TabsContent value="past">
          <Overview
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
            trials={trials}
            mode="past"
          />
        </TabsContent>

        <TabsContent value="calendar">
          <Calendar
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
            trials={trials}
          />
        </TabsContent>

        <TabsContent value="history">
          <BookingHistoryTab
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
