import { fetchAppointments } from "../../utils/fetchHelpers";
import { type IAppointment, BADGE_STYLES } from "../../types";
import { AppointmentsTab } from "./AppointmentsTab";

export default async function AppointmentsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = await params;
  const consultantId = resolvedParams.consultantId;

  let appointments: IAppointment[] = [];
  let error: string | null = null;

  try {
    appointments = await fetchAppointments(consultantId);
  } catch (err) {
    console.error("Error fetching appointments:", err);
    error =
      err instanceof Error
        ? err.message
        : "An error occurred while fetching appointments.";
  }

  if (error) {
    return (
      <div className="bg-white p-4 rounded-lg shadow-md">
        <p className="text-red-600">Error loading appointments: {error}</p>
      </div>
    );
  }

  return (
    <AppointmentsTab appointments={appointments} badgeStyles={BADGE_STYLES} />
  );
}
