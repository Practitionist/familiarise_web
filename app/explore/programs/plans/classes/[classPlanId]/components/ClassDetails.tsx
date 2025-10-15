"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import {
  Calendar,
  Clock,
  Users,
  Video,
  Globe,
  GraduationCap,
  Book,
  Award,
} from "lucide-react";
import { ClientClassRegistration } from "./ClientClassRegistration";
import type {
  Prisma,
  Class as PrismaClass,
  Appointment as PrismaAppointment,
  SlotOfAppointment as PrismaSlotOfAppointment,
  Topic,
} from "@prisma/client";
import {
  generateProgramImageUrl,
  // ClassPlanProgram, // We are defining a more specific type below
} from "@/app/explore/programs/utils";

// Define the detailed structure for a single class session with its schedule
type ClassSessionWithSchedule = PrismaClass & {
  appointments: (PrismaAppointment & {
    slotsOfAppointment: PrismaSlotOfAppointment[];
  })[];
};

// Define the main data structure for the class details page
export type ClassPlanDetailsData = Omit<
  Prisma.ClassPlanGetPayload<{
    include: {
      consultantProfile: {
        include: {
          user: { select: { id: true; name: true; image: true } };
          domain: true;
          subDomains: true;
          tags: true;
        };
      };
      // classes: true, // We will override this in the Omit<..., "classes"> & { classes: ... }
      topics: true;
      classContents: true;
    };
  }>,
  "classes"
> & {
  // Omit the original 'classes' to replace it with our detailed one
  classes: ClassSessionWithSchedule[];
  type: "class"; // Keep the type literal for consistency if needed
  imageUrl: string; // Keep imageUrl if used by ClassDetails
};

// Helper function for badge variant based on session status
const getBadgeVariant = (
  currentStatus: string,
): "outline" | "destructive" | "default" => {
  if (currentStatus === "Completed") return "outline";
  if (currentStatus === "Happening Now") return "destructive";
  return "default";
};

type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number | React.ReactNode;
};

const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex items-center gap-2">
    {icon}
    <span className="text-sm text-gray-300">
      {label}: {value}
    </span>
  </div>
);

interface ClassDetailsProps {
  readonly plan: ClassPlanDetailsData;
}

export function ClassDetails({ plan }: ClassDetailsProps) {
  return (
    <div className="min-h-screen bg-black">
      <div className="relative h-[300px] w-full">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 300)}
          alt="Class cover"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-black/50" />
      </div>

      <div className="container mx-auto px-4 -mt-20 relative">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2">
            <Card className="mb-8 bg-gradient-to-br from-gray-900/90 to-gray-800/80 border-gray-700/50">
              <CardContent className="p-6">
                <h1 className="text-3xl font-bold mb-2 text-white">
                  {plan.title}
                </h1>
                <p className="text-xl font-semibold mb-4 text-white">
                  ${plan.price} USD
                </p>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <FeatureItem
                    icon={<Calendar className="h-5 w-5" />}
                    label="Duration"
                    value={`${plan.durationInMonths} months`}
                  />
                  <FeatureItem
                    icon={<Clock className="h-5 w-5" />}
                    label="Time Commitment"
                    value={`${plan.callsPerWeek} hours/week`}
                  />
                  <FeatureItem
                    icon={<Users className="h-5 w-5" />}
                    label="Participants"
                    value={`${plan.maxParticipants} max`}
                  />
                  <FeatureItem
                    icon={<Video className="h-5 w-5" />}
                    label="Platform"
                    value={plan.materialProvided ?? "Zoom"}
                  />
                  <FeatureItem
                    icon={<Globe className="h-5 w-5" />}
                    label="Language"
                    value={plan.language ?? "English"}
                  />
                  <FeatureItem
                    icon={<GraduationCap className="h-5 w-5" />}
                    label="Level"
                    value={plan.level ?? "All Levels"}
                  />
                  <FeatureItem
                    icon={<Book className="h-5 w-5" />}
                    label="Modules"
                    value={plan.classContents.length}
                  />
                  <FeatureItem
                    icon={<Award className="h-5 w-5" />}
                    label="Certificate"
                    value={plan.certificateProvided ? "Yes" : "No"}
                  />
                </div>

                <div className="space-y-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-2 text-white">
                      About this Class
                    </h2>
                    <p className="text-gray-300 whitespace-pre-line">
                      {plan.description}
                    </p>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2 text-white">
                      What you'll learn
                    </h2>
                    <ul className="list-disc list-inside text-gray-300 space-y-1">
                      {plan.learningOutcomes.map(
                        (outcome: string, _index: number) => (
                          <li key={outcome}>{outcome}</li>
                        ),
                      )}
                    </ul>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2 text-white">
                      Prerequisites
                    </h2>
                    <p className="text-gray-300">
                      {plan.prerequisites ?? "No prerequisites required"}
                    </p>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2 text-white">
                      Course Content
                    </h2>
                    <div className="space-y-4">
                      {plan.classContents.map((content, index) => (
                        <div
                          key={content.id}
                          className="bg-gray-800/60 border border-gray-700/50 p-4 rounded-lg"
                        >
                          <h3 className="font-semibold text-white">
                            Module {index + 1}: {content.title}
                          </h3>
                          <p className="text-gray-300 mt-1">
                            {content.description}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2 text-white">
                      Topics Covered
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {plan.topics.map((topic: Topic, _index: number) => (
                        <Badge key={topic.id} variant="secondary">
                          {topic.name}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-3 text-white">
                      Class Schedule
                    </h2>
                    {plan.classes && plan.classes.length > 0 ? (
                      <div className="space-y-4">
                        {plan.classes.map((classInstance, classIndex) => (
                          <div
                            key={classInstance.id}
                            className="p-4 border border-gray-700/50 rounded-lg bg-gray-800/60"
                          >
                            {plan.classes.length > 1 && (
                              <h3 className="font-medium text-lg mb-2 text-white">
                                {`Class Session ${classIndex + 1}`}
                              </h3>
                            )}
                            {classInstance.appointments &&
                            classInstance.appointments.length > 0 ? (
                              classInstance.appointments.map((appointment) => (
                                <div
                                  key={appointment.id}
                                  className="space-y-1 mb-2"
                                >
                                  {appointment.slotsOfAppointment &&
                                  appointment.slotsOfAppointment.length > 0 ? (
                                    appointment.slotsOfAppointment.map(
                                      (slot, slotIndex) => {
                                        const startTime = new Date(
                                          slot.slotStartTimeInUTC,
                                        );
                                        const userTimeZone =
                                          Intl.DateTimeFormat().resolvedOptions()
                                            .timeZone;
                                        const formattedStartTime =
                                          new Intl.DateTimeFormat(
                                            navigator.language,
                                            {
                                              dateStyle: "full",
                                              timeStyle: "long",
                                              timeZone: userTimeZone,
                                            },
                                          ).format(startTime);

                                        // Basic status determination (can be expanded)
                                        const now = new Date();
                                        const endTime = slot.slotEndTimeInUTC
                                          ? new Date(slot.slotEndTimeInUTC)
                                          : null;
                                        let status = "Upcoming";
                                        if (endTime && now > endTime) {
                                          status = "Completed";
                                        } else if (
                                          now >= startTime &&
                                          (!endTime || now < endTime)
                                        ) {
                                          status = "Happening Now";
                                        }

                                        return (
                                          <div
                                            key={slot.id}
                                            className="text-sm text-gray-300 pl-4"
                                          >
                                            <div>
                                              {" "}
                                              {/* Changed from <p> to <div> */}
                                              <strong>
                                                Session {slotIndex + 1}:
                                              </strong>{" "}
                                              {formattedStartTime}{" "}
                                              <Badge
                                                variant={getBadgeVariant(
                                                  status,
                                                )}
                                                className="ml-2"
                                              >
                                                {status}
                                              </Badge>
                                            </div>
                                          </div>
                                        );
                                      },
                                    )
                                  ) : (
                                    <p className="text-sm text-gray-400 pl-4">
                                      No specific time slots scheduled for this
                                      session yet.
                                    </p>
                                  )}
                                </div>
                              ))
                            ) : (
                              <p className="text-sm text-gray-400">
                                Schedule to be announced for this class session.
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-gray-300">
                        Class schedule to be announced.
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div>
            <Card className="sticky top-24 mb-6 bg-gradient-to-br from-gray-900/90 to-gray-800/80 border-gray-700/50">
              <CardHeader>
                <CardTitle className="text-white">Instructor</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-4">
                  <div className="relative h-16 w-16 rounded-full overflow-hidden">
                    <Image
                      src={
                        plan.consultantProfile?.user?.image ??
                        "/placeholder-user.jpg"
                      }
                      alt={plan.consultantProfile?.user?.name ?? "Instructor"}
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white">
                      {plan.consultantProfile?.user?.name}
                    </h3>
                    <p className="text-sm text-gray-300">Expert Instructor</p>
                  </div>
                </div>
                <p className="text-sm text-gray-300">
                  An experienced professional dedicated to sharing knowledge and
                  expertise.
                </p>
              </CardContent>
            </Card>

            <ClientClassRegistration plan={plan} />
          </div>
        </div>
      </div>
    </div>
  );
}
