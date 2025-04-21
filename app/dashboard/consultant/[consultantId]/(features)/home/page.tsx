"use client";

import { useEffect, useState, use } from "react";
import {
  fetchAppointments,
  fetchActivities,
  fetchApprovals,
} from "../../utils/fetchHelpers";
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

  const fetchData = async () => {
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
  };

  useEffect(() => {
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

  const getBadgeStyle = (badge: string): string => {
    return BADGE_STYLES[badge] || BADGE_STYLES.default;
  };

  const handleUpdate = async () => {
    // Add a small delay to ensure the backend has completed processing
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await fetchData();
  };

  return (
    <HomeTab
      appointments={appointments}
      activities={activities}
      approvals={approvals}
      getBadgeStyle={getBadgeStyle}
      onUpdate={handleUpdate}
    />
  );
}
