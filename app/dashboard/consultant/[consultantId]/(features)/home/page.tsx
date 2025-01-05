"use client";

import { useEffect, useState, use } from "react";
import {
  fetchAppointments,
  fetchActivities,
  fetchApprovals,
} from "../../utils";
import {
  type IAppointment,
  type IActivity,
  type IApproval,
  BADGE_STYLES,
} from "../../types";
import { HomeTab } from "./HomeTab";

export default function HomePage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const [appointments, setAppointments] = useState<IAppointment[]>([]);
  const [activities, setActivities] = useState<IActivity[]>([]);
  const [approvals, setApprovals] = useState<IApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        const [appointmentsData, activitiesData, approvalsData] =
          await Promise.all([
            fetchAppointments(consultantId),
            fetchActivities(consultantId),
            fetchApprovals(consultantId),
          ]);

        setAppointments(appointmentsData);
        setActivities(activitiesData);
        setApprovals(approvalsData);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, [consultantId]);

  if (error) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p>Loading...</p>
      </div>
    );
  }

  // Filter appointments for today
  const todayAppointments = appointments.filter((appointment) => {
    if (appointment.badge === "Completed") return false;
    if (
      appointment.badge.includes("min") ||
      appointment.badge.includes("hours")
    ) {
      return true;
    }
    return !appointment.time.includes(",");
  });

  // Get upcoming appointments (not today)
  const upcomingAppointments = appointments.filter((appointment) => {
    if (
      appointment.badge === "Completed" ||
      appointment.badge.includes("min") ||
      appointment.badge.includes("hours")
    ) {
      return false;
    }
    return (
      appointment.time.includes(",") ||
      appointment.badge === "Tomorrow" ||
      appointment.badge.startsWith("In ")
    );
  });

  const getBadgeStyle = (badge: string): string => {
    return BADGE_STYLES[badge] || BADGE_STYLES.default;
  };

  return (
    <HomeTab
      todayAppointments={todayAppointments}
      upcomingAppointments={upcomingAppointments}
      activities={activities}
      approvals={approvals}
      getBadgeStyle={getBadgeStyle}
    />
  );
}
