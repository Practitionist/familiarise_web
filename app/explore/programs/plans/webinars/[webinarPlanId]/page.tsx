"use client";

import { use, useEffect, useState } from "react";
import { Video } from "lucide-react";
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
      } finally {
        setIsLoading(false);
      }
    };

    fetchWebinarPlanData();
  }, [webinarPlanId]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Video className="w-6 h-6 text-zinc-400" />
            </div>
          </div>
          <p className="text-zinc-500 text-sm">Loading webinar details...</p>
        </div>
      </main>
    );
  }

  if (!webinarData) return null;

  const firstWebinarInstance = webinarData.webinars?.[0];
  const nextSession =
    firstWebinarInstance?.appointment?.slotsOfAppointment?.[0]?.startsAt;

<<<<<<< Updated upstream
  // Pass the entire webinarData (WebinarPlanData) as the 'plan' prop.
  // 'webinarInstanceId' is currently the WebinarPlan.id.
  // This is used by ClientWebinarRegistration; it might need re-evaluation if registration
  // becomes specific to a distinct Webinar *instance* ID rather than the plan's ID.
  return <WebinarDetails plan={webinarData} nextSession={nextSession} />;
=======
  return (
    <WebinarDetails
      plan={webinarData}
      nextSession={nextSession}
      webinarId={firstWebinarInstance?.id}
    />
  );
>>>>>>> Stashed changes
}
