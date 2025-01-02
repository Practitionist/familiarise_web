import { getServerSession } from "next-auth";
import { generateProgramImageUrl } from "../../utils";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

type WebinarWithRelations = Prisma.WebinarPlanGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: true;
      };
    };
    topics: true;
    webinars: {
      where: {
        status: "SCHEDULED";
      };
      take: 1;
      include: {
        appointment: {
          include: {
            slotsOfAppointment: true;
          };
        };
      };
    };
  };
}>;

async function getWebinarPlan(
  webinarId: string,
): Promise<WebinarWithRelations | null> {
  return prisma.webinarPlan.findUnique({
    where: { id: webinarId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
      topics: true,
      webinars: {
        where: {
          status: "SCHEDULED",
        },
        take: 1,
        include: {
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
        },
      },
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

type WebinarRegistrationProps = {
  webinarId: string;
  price: number;
  isLoggedIn: boolean;
  nextSession?: Date;
  language?: string | null;
};

const WebinarRegistration = ({
  webinarId,
  price,
  isLoggedIn,
  nextSession,
  language,
}: WebinarRegistrationProps) => {
  if (!isLoggedIn) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Register for Webinar</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            action="/api/events/webinars/book"
            method="POST"
            className="space-y-4"
          >
            <input type="hidden" name="webinarId" value={webinarId} />
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="name"
                  className="block text-sm font-medium text-gray-700"
                >
                  Full Name
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-gray-700"
                >
                  Email
                </label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor="phone"
                  className="block text-sm font-medium text-gray-700"
                >
                  Phone Number
                </label>
                <input
                  type="tel"
                  id="phone"
                  name="phone"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                  placeholder="+1234567890"
                />
              </div>
              <div>
                <label
                  htmlFor="preferredLanguage"
                  className="block text-sm font-medium text-gray-700"
                >
                  Preferred Language
                </label>
                <input
                  type="text"
                  id="preferredLanguage"
                  name="preferredLanguage"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                  placeholder="e.g., English, Spanish, etc."
                  defaultValue={language || ""}
                />
              </div>
            </div>
            <Button type="submit" className="w-full bg-black hover:bg-gray-800">
              Pay ${price} USD & Register
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join Webinar</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-600 mb-4">
          {nextSession
            ? `Next session starts on ${new Date(nextSession).toLocaleString(
                undefined,
                {
                  dateStyle: "long",
                  timeStyle: "short",
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
              )}`
            : "No upcoming sessions scheduled yet"}
        </p>
      </CardContent>
      <CardFooter>
        <form
          action="/api/events/webinars/book"
          method="POST"
          className="w-full"
        >
          <input type="hidden" name="webinarId" value={webinarId} />
          <input
            type="hidden"
            name="timezone"
            value={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
          <Button type="submit" className="w-full bg-black hover:bg-gray-800">
            Pay ${price} USD & Register Now
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
};

interface PageProps {
  params: Promise<{ webinarId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function WebinarDetailsPage({
  params,
  searchParams,
}: PageProps) {
  const { webinarId } = await params;
  const session = await getServerSession();
  const webinar = await getWebinarPlan(webinarId);

  if (!webinar) {
    redirect("/explore/programs/webinars");
  }

  const nextSession =
    webinar.webinars[0]?.appointment?.slotsOfAppointment?.[0]
      ?.slotStartTimeInUTC;
  const isLoggedIn = !!session?.user;
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="relative h-[300px] w-full">
        <Image
          src={generateProgramImageUrl(webinar.id, 1200, 300)}
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
                <h1 className="text-3xl font-bold mb-2">{webinar.title}</h1>
                <p className="text-xl font-semibold mb-4 text-blue-600">
                  ${webinar.price} USD
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
                    value={`${webinar.durationInHours} hours`}
                  />
                  <FeatureItem
                    icon={<UsersIcon />}
                    label="Participants"
                    value={`${webinar.maxParticipants} max`}
                  />
                  <FeatureItem
                    icon={<VideoIcon />}
                    label="Platform"
                    value={webinar.materialProvided || "Zoom"}
                  />
                  <FeatureItem
                    icon={<GlobeIcon />}
                    label="Language"
                    value={webinar.language || "English"}
                  />
                  <FeatureItem
                    icon={<CertificateIcon />}
                    label="Level"
                    value={webinar.level || "All Levels"}
                  />
                </div>

                <div className="space-y-6">
                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      About this Webinar
                    </h2>
                    <p className="text-gray-600 whitespace-pre-line">
                      {webinar.description}
                    </p>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold mb-2">
                      What you'll learn
                    </h2>
                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                      {webinar.learningOutcomes.map(
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
                      {webinar.topics.map((topic) => (
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
                        webinar.consultantProfile?.user?.image ||
                        "/placeholder-user.jpg"
                      }
                      alt={
                        webinar.consultantProfile?.user?.name || "Instructor"
                      }
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      {webinar.consultantProfile?.user?.name}
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

            <WebinarRegistration
              webinarId={webinar.id}
              price={webinar.price}
              isLoggedIn={isLoggedIn}
              nextSession={nextSession}
              language={webinar.language}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
