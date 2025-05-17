import { BADGE_STYLES } from "../../types";
import {
  fetchActivities,
  fetchAppointments,
  fetchApprovals,
} from "../../utils/fetchHelpers";
import { HomeTab } from "./HomeTab";

export default async function HomePage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const resolvedParams = await params;
  const { consultantId } = resolvedParams;

  // Fetch data directly using await. Suspense will handle loading.
  // Note: Error handling needs adjustment. Let's handle basic case first.
  // A more robust solution might involve Error Boundaries or checking results.
  const [appointments, activities, approvals] = await Promise.all([
    fetchAppointments(consultantId),
    fetchActivities(consultantId),
    fetchApprovals(consultantId),
  ]).catch((err) => {
    // Basic error handling for now: log and return empty arrays
    console.error("Error fetching home page data:", err);
    // In a real app, you might throw error to an Error Boundary or display a message
    return [[], [], []];
  });

  return (
    <HomeTab
      appointments={appointments}
      activities={activities}
      approvals={approvals}
      badgeStyles={BADGE_STYLES}
    />
  );
}
