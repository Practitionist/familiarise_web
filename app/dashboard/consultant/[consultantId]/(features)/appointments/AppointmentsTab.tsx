"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { joinAppointmentMeeting } from "@/lib/meeting";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { AppointmentsTabProps } from "../../types";
import {
  getConsumeeName,
  getConsumeeImage,
  getStartTime,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  groupRecurringAppointments,
  getGroupTitle,
  getGroupStatus,
} from "../../utils/appointmentHelpers";

export function AppointmentsTab({
  appointments,
  getBadgeStyle,
}: Readonly<AppointmentsTabProps>) {
  const router = useRouter();
  const client = useStreamVideoClient();
  const { toast } = useToast();

  const handleJoinMeeting = async (appointment: any) => {
    try {
      if (!client) {
        toast({
          title: "Not signed in",
          description:
            "Video client not initialized. You have to sign in to join a meeting.",
          variant: "warning",
        });
        return;
      }

      const meetingId = await joinAppointmentMeeting(client, appointment);
      router.push(`/meetings/${meetingId}`);
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting",
        variant: "success",
      });
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };
  // Group appointments by subscription/class
  const groupedAppointments = groupRecurringAppointments(appointments || []);

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">All Appointments</h2>
      <div className="space-y-6">
        {Object.entries(groupedAppointments).map(
          ([groupKey, groupAppointments]) => {
            const isRecurring =
              groupKey.startsWith("subscription-") ||
              groupKey.startsWith("class-");
            const groupTitle = getGroupTitle(groupAppointments);
            const groupStatus = getGroupStatus(groupAppointments);
            const firstAppointment = groupAppointments[0];

            return (
              <div key={groupKey} className="border rounded-lg overflow-hidden">
                {/* Group Header */}
                {isRecurring && (
                  <div className="bg-gray-50 p-4 border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-4">
                        <Avatar>
                          <AvatarImage
                            alt={getConsumeeName(firstAppointment)}
                            src={getConsumeeImage(firstAppointment)}
                          />
                          <AvatarFallback>
                            {getConsumeeName(firstAppointment)
                              .split(" ")
                              .map((n: string) => n[0])
                              .join("")}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <h3 className="font-semibold">
                            {getConsumeeName(firstAppointment)}
                          </h3>
                          <p className="text-sm text-gray-600">{groupTitle}</p>
                        </div>
                      </div>
                      <Badge
                        variant="secondary"
                        className={getBadgeStyle(groupStatus)}
                      >
                        {groupStatus}
                      </Badge>
                    </div>
                  </div>
                )}

                {/* Appointments List */}
                <ul className="divide-y">
                  {groupAppointments.map((appointment) => {
                    const status = getAppointmentStatus(appointment);
                    const isJoinable = status === "Meeting in 5 min";
                    const joinButtonStyle = isJoinable
                      ? "bg-black text-white hover:bg-gray-800"
                      : "bg-gray-400 text-white cursor-not-allowed";

                    return (
                      <li
                        key={appointment.id}
                        className="flex items-center justify-between p-4 hover:bg-gray-50"
                      >
                        <div className="flex items-center space-x-4">
                          {!isRecurring && (
                            <Avatar>
                              <AvatarImage
                                alt={getConsumeeName(appointment)}
                                src={getConsumeeImage(appointment)}
                              />
                              <AvatarFallback>
                                {getConsumeeName(appointment)
                                  .split(" ")
                                  .map((n: string) => n[0])
                                  .join("")}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <div>
                            {!isRecurring && (
                              <>
                                <h3 className="font-semibold">
                                  {getConsumeeName(appointment)}
                                </h3>
                                <p className="text-sm text-gray-600">
                                  {getAppointmentTypeAndPlan(appointment)}
                                </p>
                              </>
                            )}
                            <p className="text-sm text-gray-500">
                              {getStartTime(appointment)
                                ? formatAppointmentTime(
                                    getStartTime(appointment)!,
                                  )
                                : "Time not set"}
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
                          {status !== "Completed" && (
                            <Button
                              variant="default"
                              className={joinButtonStyle}
                              disabled={
                                process.env.NODE_ENV === "production"
                                  ? !isJoinable
                                  : false
                              }
                              onClick={() => {
                                if (process.env.NODE_ENV === "production") {
                                  // Production behavior
                                  if (isJoinable) {
                                    handleJoinMeeting(appointment);
                                  }
                                } else {
                                  // Development behavior - more flexible for testing
                                  toast({
                                    title: "Development Mode",
                                    description: `Joining meeting with ID: ${appointment.id}`,
                                    variant: "info",
                                  });
                                  handleJoinMeeting(appointment);
                                }
                              }}
                            >
                              {process.env.NODE_ENV === "production"
                                ? isJoinable
                                  ? "Join meet"
                                  : "Not available"
                                : "Join (Dev)"}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          },
        )}
        {!Object.keys(groupedAppointments).length && (
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
      </div>
    </div>
  );
}
