"use client";

import { useEffect, useState, use } from "react";
import { fetchAppointments } from "../../utils";
import { type IAppointment, BADGE_STYLES } from "../../types";
import { AppointmentsTab } from "./AppointmentsTab";

export default function AppointmentsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const [appointments, setAppointments] = useState<IAppointment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        const appointmentsData = await fetchAppointments(consultantId);
        setAppointments(appointmentsData);
      } catch (err) {
        console.error("Error fetching appointments:", err);
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

  const getBadgeStyle = (badge: string): string => {
    return BADGE_STYLES[badge] || BADGE_STYLES.default;
  };

  return (
    <AppointmentsTab
      appointments={appointments}
      getBadgeStyle={getBadgeStyle}
    />
  );
}
