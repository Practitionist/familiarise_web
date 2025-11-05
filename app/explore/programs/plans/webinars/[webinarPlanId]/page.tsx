"use client";

import { use, useEffect, useState } from "react";
import {
  WebinarDetails,
  type WebinarPlanData,
} from "./components/WebinarDetails";

export default function WebinarDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ webinarPlanId: string }>;
}>) {
  const [webinarData, setWebinarData] = useState<WebinarPlanData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const resolvedParams = use(params);
  const webinarPlanId = resolvedParams.webinarPlanId;

  useEffect(() => {
    const fetchWebinarPlanData = async () => {
      try {
        const response = await fetch(`/api/plans/webinars/${webinarPlanId}`);
        if (!response.ok) throw new Error("Failed to fetch webinar data");
        const resJson = await response.json();
        setWebinarData(resJson.data);
      } catch (error) {
        console.error("Error fetching webinar data:", error);
        // redirect("/explore/programs/webinars");
      } finally {
        setIsLoading(false);
      }
    };

    fetchWebinarPlanData();
  }, [webinarPlanId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!webinarData) return null;

  // Attempt to get the next session's start time from the first available webinar instance.
  // This relies on the API response including nested: webinars > appointment > slotsOfAppointment.
  const firstWebinarInstance = webinarData.webinars?.[0];
  const nextSession =
    firstWebinarInstance?.appointment?.slotsOfAppointment?.[0]?.startsAt;

  // Pass the entire webinarData (WebinarPlanData) as the 'plan' prop.
  // 'webinarInstanceId' is currently the WebinarPlan.id.
  // This is used by ClientWebinarRegistration; it might need re-evaluation if registration
  // becomes specific to a distinct Webinar *instance* ID rather than the plan's ID.
  return <WebinarDetails plan={webinarData} nextSession={nextSession} />;
}
