import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppointmentsTabProps, IAppointment } from "../../types";
import {
  getConsumeeName,
  getConsumeeImage,
  getStartTime,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  sortAppointmentsByStartTime
} from "../../utils/appointmentHelpers";

export function AppointmentsTab({
  appointments,
  getBadgeStyle,
}: Readonly<AppointmentsTabProps>) {
  // Sort appointments by start time
  const sortedAppointments = sortAppointmentsByStartTime(appointments || []);

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">All Appointments</h2>
      <ul className="space-y-4">
        {sortedAppointments.map((appointment) => {
          const userName = getConsumeeName(appointment);
          const status = getAppointmentStatus(appointment);
          const isJoinable = status === "Meeting in 5 min";
          const joinButtonStyle = isJoinable
            ? "bg-black text-white hover:bg-gray-800"
            : "bg-gray-400 text-white cursor-not-allowed";

          return (
            <li
              key={appointment.id}
              className="flex items-center justify-between p-4 bg-gray-100 rounded-lg"
            >
              <div className="flex items-center space-x-4">
                <Avatar>
                  <AvatarImage 
                    alt={userName} 
                    src={getConsumeeImage(appointment)} 
                  />
                  <AvatarFallback>
                    {userName
                      .split(" ")
                      .map((n: string) => n[0])
                      .join("")}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="font-semibold">
                    {userName}
                  </h3>
                  <p className="text-sm text-gray-600">
                    {getAppointmentTypeAndPlan(appointment)}
                  </p>
                  <p className="text-sm text-gray-500">
                    {getStartTime(appointment) ? formatAppointmentTime(getStartTime(appointment)!) : 'Time not set'}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <Badge
                  variant="secondary"
                  className={getBadgeStyle(status)}
                >
                  {status}
                </Badge>
                <Button
                  variant="default"
                  className={joinButtonStyle}
                  disabled={!isJoinable}
                >
                  Join meet
                </Button>
              </div>
            </li>
          );
        })}
        {!sortedAppointments.length && (
          <div className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-gray-50 rounded-lg">
            <div className="w-16 h-16 mb-4 text-gray-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">
              No Appointments Found
            </h3>
            <p className="text-gray-500 text-center">
              You don't have any appointments scheduled at the moment.
            </p>
          </div>
        )}
      </ul>
    </div>
  );
}
