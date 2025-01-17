import { getServerSession } from "next-auth";
import { generateProgramImageUrl } from "../../utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import Image from "next/image";
import { redirect } from "next/navigation";
import {
  CalendarIcon,
  ClockIcon,
  UsersIcon,
  VideoIcon,
  GlobeIcon,
  CertificateIcon,
} from "./icons";
import { ClientWebinarRegistration } from "./components/ClientWebinarRegistration";

type WebinarWithRelations = Prisma.WebinarGetPayload<{
  include: {
    webinarPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
        topics: true;
      };
    };
    appointment: {
      include: {
        slotsOfAppointment: true;
      };
    };
    meetingRoom: true;
  };
}>;

async function getWebinar(
  webinarId: string,
): Promise<WebinarWithRelations | null> {
  return prisma.webinar.findUnique({
    where: { id: webinarId },
    include: {
      webinarPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
          topics: true,
        },
      },
      appointment: {
        include: {
          slotsOfAppointment: true,
        },
      },
      meetingRoom: true,
    },
  });
}

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

interface PageProps {
  params: Promise<{ webinarId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function WebinarDetailsPage({
  params,
  searchParams,
}: PageProps) {
  const { webinarId } = await params;
  const webinar = await getWebinar(webinarId);

  if (!webinar) {
    redirect("/explore/programs/webinars");
  }

  const { webinarPlan } = webinar;
  const nextSession = webinar.appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="relative h-[300px] w-full">
        <Image
          src={generateProgramImageUrl(webinarPlan.id, 1200, 300)}
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
                <h1 className="text-3xl font-bold mb-2">{webinarPlan.title}</h1>
                <p className="text-xl font-semibold mb-4 text-blue-600">
                  ${webinarPlan.price} USD
                </p>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <FeatureItem
                    icon={<CalendarIcon />}
                    label="Next Session"
                    value={
                      nextSession
                        ? new Date(nextSession).toLocaleString(undefined, {
                            dateStyle: "long",
                            timeStyle: "short",
                            timeZone:
                              Intl.DateTimeFormat().resolvedOptions().timeZone,
                          })
                        : "To be announced"
                    }
                  />
                  <FeatureItem
                    icon={<ClockIcon />}
                    label="Duration"
                    value={`${webinarPlan.durationInHours} hours`}
                  />
                  <FeatureItem
                    icon={<UsersIcon />}
                    label="Participants"
                    value={`${webinarPlan.maxParticipants} max`}
                  />
                  <FeatureItem
                    icon={<VideoIcon />}
                    label="Platform"
                    value={webinarPlan.materialProvided || "Zoom"}
                  />
                  <FeatureItem
                    icon={<GlobeIcon />}
                    label="Language"
                    value={webinarPlan.language || "English"}
                  />
                  <FeatureItem
                    icon={<CertificateIcon />}
                    label="Level"
                    value={webinarPlan.level || "All Levels"}
                  />
                </div>

                <div className="space-y-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      About this Webinar
                    </h2>
                    <p className="text-gray-600 whitespace-pre-line">
                      {webinarPlan.description}
                    </p>
                  </div>

                  {webinar.appointment?.slotsOfAppointment && webinar.appointment.slotsOfAppointment.length > 0 && (
                    <div>
                      <h2 className="text-xl font-semibold mb-2">
                        Webinar Schedule
                      </h2>
                      <div className="space-y-2">
                        {webinar.appointment.slotsOfAppointment.map((slot, slotIndex) => (
                          <div key={slotIndex} className="bg-gray-800/10 p-4 rounded-lg">
                            <div className="font-medium">
                              {new Date(slot.slotStartTimeInUTC).toLocaleString(undefined, {
                                weekday: "long",
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                              })}
                            </div>
                            <div className="text-gray-600 text-sm">
                              {new Date(slot.slotStartTimeInUTC).toLocaleTimeString(undefined, {
                                hour: "numeric",
                                minute: "2-digit",
                                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                              })} - {" "}
                              {new Date(slot.slotEndTimeInUTC).toLocaleTimeString(undefined, {
                                hour: "numeric",
                                minute: "2-digit",
                                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
                      {webinarPlan.learningOutcomes.map(
                        (outcome: string, index: number) => (
                          <li key={index}>{outcome}</li>
                        ),
                      )}
                    </ul>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      Topics Covered
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {webinarPlan.topics.map((topic) => (
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
                        webinarPlan.consultantProfile?.user?.image ||
                        "/placeholder-user.jpg"
                      }
                      alt={
                        webinarPlan.consultantProfile?.user?.name || "Instructor"
                      }
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      {webinarPlan.consultantProfile?.user?.name}
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
              webinarId={webinar.id}
              price={webinarPlan.price}
              nextSession={nextSession}
              language={webinarPlan.language}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
