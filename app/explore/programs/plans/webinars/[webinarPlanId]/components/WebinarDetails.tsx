"use client";

import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CalendarIcon,
  ClockIcon,
  UsersIcon,
  VideoIcon,
  GlobeIcon,
  CertificateIcon,
} from "../icons";
import { ClientWebinarRegistration } from "./ClientWebinarRegistration";
import { generateProgramImageUrl } from "../../../../utils";
import type { Prisma, Topic } from "@prisma/client";

// Define the specific type for the plan prop
// This corresponds to webinarData.webinarPlan from page.tsx
export type WebinarPlanData = Prisma.WebinarPlanGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: true;
      };
    };
    topics: true;
    webinars: {
      include: {
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
            payment: true,
          },
        },
        // Include other necessary fields from the Webinar model itself if needed by WebinarDetails
        // e.g., status: true, meetingRoom: true (if meetingRoom is a direct relation of Webinar)
      },
    };
    // Ensure all fields accessed from 'plan' in the JSX are included here
    // For example, learningOutcomes is usually part of WebinarPlan model directly
  };
}>;

// FeatureItem component (moved from page.tsx)
type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number | React.ReactNode;
};

const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex items-center gap-2">
    {icon}
    <span className="text-sm text-gray-600">
      {label}: {value}
    </span>
  </div>
);

// Add a type for session status
type SessionStatus = "Upcoming" | "Happening Now" | "Completed" | "To be announced";

interface WebinarDetailsProps {
  readonly plan: WebinarPlanData; // This is webinarData.webinarPlan
  readonly nextSession: Date | string | undefined; // Allow string for initial prop
}

export function WebinarDetails({ plan, nextSession }: WebinarDetailsProps) {
  let sessionStatus: SessionStatus = "To be announced";
  let formattedNextSessionDisplay = "To be announced"; // Used for display under FeatureItem

  if (nextSession && plan.durationInHours !== null && plan.durationInHours !== undefined) {
    const sessionStart = new Date(nextSession); // nextSession is slotStartTimeInUTC
    const durationInMilliseconds = plan.durationInHours * 60 * 60 * 1000;
    const sessionEnd = new Date(sessionStart.getTime() + durationInMilliseconds);
    const now = new Date();

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (now > sessionEnd) {
      sessionStatus = "Completed";
      formattedNextSessionDisplay = `Ended on ${sessionEnd.toLocaleString(undefined, {
        dateStyle: "long",
        timeStyle: "short",
        timeZone,
      })}`;
    } else if (now >= sessionStart && now <= sessionEnd) {
      sessionStatus = "Happening Now";
      formattedNextSessionDisplay = `Ends at ${sessionEnd.toLocaleTimeString(undefined, {
        timeStyle: "short",
        timeZone,
      })}`;
    } else if (now < sessionStart) {
      sessionStatus = "Upcoming";
      formattedNextSessionDisplay = sessionStart.toLocaleString(undefined, {
        dateStyle: "long",
        timeStyle: "short",
        timeZone,
      });
    }
  } else if (nextSession) {
    // Case where duration is null/undefined but nextSession exists
    sessionStatus = "Upcoming"; // Default to upcoming if only start time is known
    formattedNextSessionDisplay = new Date(nextSession).toLocaleString(undefined, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="relative h-[300px] w-full">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 300)} // plan.id is WebinarPlan.id
          alt="Webinar cover"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-black/50" />
      </div>

      <div className="container mx-auto px-4 -mt-20 relative">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2">
            <Card className="mb-8">
              <CardContent className="p-6">
                <h1 className="text-3xl font-bold mb-2">{plan.title}</h1>
                <p className="text-xl font-semibold mb-4 text-blue-600">
                  ${plan.price} USD
                </p>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <FeatureItem
                    icon={<CalendarIcon />}
                    label={sessionStatus === "Happening Now" || sessionStatus === "Completed" ? "Status" : "Next Session"}
                    value={formattedNextSessionDisplay}
                  />
                  <FeatureItem
                    icon={<ClockIcon />}
                    label="Duration"
                    value={`${plan.durationInHours} hours`}
                  />
                  <FeatureItem
                    icon={<UsersIcon />}
                    label="Participants"
                    value={`${plan.maxParticipants} max`}
                  />
                  <FeatureItem
                    icon={<VideoIcon />}
                    label="Platform"
                    value={plan.materialProvided ?? "Zoom"}
                  />
                  <FeatureItem
                    icon={<GlobeIcon />}
                    label="Language"
                    value={plan.language ?? "English"}
                  />
                  <FeatureItem
                    icon={<CertificateIcon />}
                    label="Level"
                    value={plan.level ?? "All Levels"}
                  />
                </div>

                <div className="space-y-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      About this Webinar
                    </h2>
                    <p className="text-gray-600 whitespace-pre-line">
                      {plan.description}
                    </p>
                  </div>

                  {/* Assuming plan.appointment is not available on WebinarPlanData, schedule comes from TWebinar directly */}
                  {/* If schedule details were part of WebinarPlanData, this section would need adjustment */}
                  {/* For now, removing this section as it relies on TWebinar.appointment which is not passed directly to this component's 'plan' prop */}
                  {/* The schedule display logic should remain in page.tsx or be passed differently if needed here */}

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      What you'll learn
                    </h2>
                    {/* Ensure learningOutcomes is part of WebinarPlanData type or WebinarPlan model */}
                    {plan.learningOutcomes && (
                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                      {plan.learningOutcomes.map(
                        (outcome: string, _index: number) => (
                          <li key={outcome}>{outcome}</li>
                        ),
                      )}
                    </ul>
                    )}
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      Topics Covered
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {plan.topics.map((topic: Topic) => (
                        <Badge key={topic.id} variant="secondary">
                          {topic.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div>
            <Card className="sticky top-24 mb-6">
              <CardHeader>
                <CardTitle>Instructor</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-4">
                  <div className="relative h-16 w-16 rounded-full overflow-hidden">
                    <Image
                      src={
                        plan.consultantProfile?.user?.image ??
                        "/placeholder-user.jpg"
                      }
                      alt={
                        plan.consultantProfile?.user?.name ?? "Instructor"
                      }
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      {plan.consultantProfile?.user?.name}
                    </h3>
                    <p className="text-sm text-gray-600">Expert Instructor</p>
                  </div>
                </div>
                <p className="text-sm text-gray-600">
                  An experienced professional dedicated to sharing knowledge and
                  expertise.
                </p>
              </CardContent>
            </Card>

            <ClientWebinarRegistration
              webinarPlanId={plan.id} // This is the WebinarPlan ID
              price={plan.price}
              currency={plan.priceCurrency}
              nextSessionDate={nextSession ? new Date(nextSession) : undefined}
              sessionStatus={sessionStatus} // Pass the calculated status
              // consultantUserId={plan.consultantProfile.userId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
