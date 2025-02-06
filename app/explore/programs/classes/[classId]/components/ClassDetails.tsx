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
import { generateProgramImageUrl } from "../../../utils";
import type { Prisma } from "@prisma/client";
import { TClass } from "@/types/appointment";

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

interface ClassDetailsProps {
  classData: TClass;
}

export function ClassDetails({ classData }: ClassDetailsProps) {
  const { classPlan } = classData;
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="relative h-[300px] w-full">
        <Image
          src={generateProgramImageUrl(classData.id, 1200, 300)}
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
            <Card className="mb-8">
              <CardContent className="p-6">
                <h1 className="text-3xl font-bold mb-2">{classPlan.title}</h1>
                <p className="text-xl font-semibold mb-4 text-blue-600">
                  ${classPlan.price} USD
                </p>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <FeatureItem
                    icon={<Calendar className="h-5 w-5" />}
                    label="Duration"
                    value={`${classPlan.durationInMonths} months`}
                  />
                  <FeatureItem
                    icon={<Clock className="h-5 w-5" />}
                    label="Time Commitment"
                    value={`${classPlan.callsPerWeek} hours/week`}
                  />
                  <FeatureItem
                    icon={<Users className="h-5 w-5" />}
                    label="Participants"
                    value={`${classPlan.maxParticipants} max`}
                  />
                  <FeatureItem
                    icon={<Video className="h-5 w-5" />}
                    label="Platform"
                    value={classPlan.materialProvided || "Zoom"}
                  />
                  <FeatureItem
                    icon={<Globe className="h-5 w-5" />}
                    label="Language"
                    value={classPlan.language || "English"}
                  />
                  <FeatureItem
                    icon={<GraduationCap className="h-5 w-5" />}
                    label="Level"
                    value={classPlan.level || "All Levels"}
                  />
                  <FeatureItem
                    icon={<Book className="h-5 w-5" />}
                    label="Modules"
                    value={classPlan.classContents.length}
                  />
                  <FeatureItem
                    icon={<Award className="h-5 w-5" />}
                    label="Certificate"
                    value={classPlan.certificateProvided ? "Yes" : "No"}
                  />
                </div>

                <div className="space-y-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      About this Class
                    </h2>
                    <p className="text-gray-600 whitespace-pre-line">
                      {classPlan.description}
                    </p>
                  </div>

                  {classData.appointments &&
                    classData.appointments.length > 0 && (
                      <div>
                        <h2 className="text-xl font-semibold mb-2">
                          Class Schedule
                        </h2>
                        <div className="space-y-2">
                          {classData.appointments
                            .flatMap((appointment) =>
                              appointment.slotsOfAppointment?.map((slot) => ({
                                slot,
                                appointmentId: appointment.id,
                              })),
                            )
                            .sort(
                              (a, b) =>
                                new Date(a.slot.slotStartTimeInUTC).getTime() -
                                new Date(b.slot.slotStartTimeInUTC).getTime(),
                            )
                            .map((item, index) => (
                              <div
                                key={`${item.appointmentId}-${index}`}
                                className="bg-gray-800/10 p-4 rounded-lg"
                              >
                                <div className="font-medium">
                                  {new Date(
                                    item.slot.slotStartTimeInUTC,
                                  ).toLocaleString(undefined, {
                                    weekday: "long",
                                    year: "numeric",
                                    month: "long",
                                    day: "numeric",
                                  })}
                                </div>
                                <div className="text-gray-600 text-sm">
                                  {new Date(
                                    item.slot.slotStartTimeInUTC,
                                  ).toLocaleTimeString(undefined, {
                                    hour: "numeric",
                                    minute: "2-digit",
                                    timeZone:
                                      Intl.DateTimeFormat().resolvedOptions()
                                        .timeZone,
                                  })}{" "}
                                  -{" "}
                                  {new Date(
                                    item.slot.slotEndTimeInUTC,
                                  ).toLocaleTimeString(undefined, {
                                    hour: "numeric",
                                    minute: "2-digit",
                                    timeZone:
                                      Intl.DateTimeFormat().resolvedOptions()
                                        .timeZone,
                                  })}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      What you'll learn
                    </h2>
                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                      {classPlan.learningOutcomes.map(
                        (outcome: string, index: number) => (
                          <li key={index}>{outcome}</li>
                        ),
                      )}
                    </ul>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      Prerequisites
                    </h2>
                    <p className="text-gray-600">
                      {classPlan.prerequisites || "No prerequisites required"}
                    </p>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      Course Content
                    </h2>
                    <div className="space-y-4">
                      {classPlan.classContents.map((content, index) => (
                        <div
                          key={content.id}
                          className="bg-gray-800/10 p-4 rounded-lg"
                        >
                          <h3 className="font-semibold">
                            Module {index + 1}: {content.title}
                          </h3>
                          <p className="text-gray-600 mt-1">
                            {content.description}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      Topics Covered
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {classPlan.topics.map((topic) => (
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
                        classPlan.consultantProfile?.user?.image ||
                        "/placeholder-user.jpg"
                      }
                      alt={
                        classPlan.consultantProfile?.user?.name || "Instructor"
                      }
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      {classPlan.consultantProfile?.user?.name}
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

            <ClientClassRegistration
              classId={classData.id}
              price={classPlan.price}
              startDate={classData.startDate || undefined}
              language={classPlan.language}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
