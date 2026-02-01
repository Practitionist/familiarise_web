"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Calendar,
  Clock,
  Users,
  Video,
  Globe,
  GraduationCap,
  Book,
  Award,
  CheckCircle2,
  ArrowLeft,
  Play,
} from "lucide-react";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { useCurrency } from "@/lib/hooks/useCurrency";
import type {
  Prisma,
  Class as PrismaClass,
  Appointment as PrismaAppointment,
  SlotOfAppointment as PrismaSlotOfAppointment,
  Topic,
} from "@prisma/client";
import { generateProgramImageUrl } from "@/app/explore/programs/utils";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";

type ClassSessionWithSchedule = PrismaClass & {
  appointments: (PrismaAppointment & {
    slotsOfAppointment: PrismaSlotOfAppointment[];
  })[];
  waitlist?: Array<{ userId: string; position: number | null; status: string }>;
};

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
      topics: true;
      classContents: true;
    };
  }>,
  "classes"
> & {
  classes: ClassSessionWithSchedule[];
  type: "class";
  imageUrl: string;
};

const getBadgeVariant = (
  currentStatus: string,
): "outline" | "destructive" | "default" => {
  if (currentStatus === "Completed") return "outline";
  if (currentStatus === "Happening Now") return "destructive";
  return "default";
};


interface ClassDetailsProps {
  readonly plan: ClassPlanDetailsData;
}

export function ClassDetails({ plan }: ClassDetailsProps) {
  const { formatPrice } = useCurrency();

  return (
    <main className="min-h-screen bg-zinc-50">
      {/* Hero Banner */}
      <div className="relative h-[350px] md:h-[400px] w-full overflow-hidden">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 400)}
          alt="Class cover"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />

        {/* Back Navigation */}
        <div className="absolute top-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-6">
            <Link
              href="/explore/programs"
              className="inline-flex items-center gap-2 text-sm text-white/80 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Programs
            </Link>
          </div>
        </div>

        {/* Title Overlay */}
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 pb-8">
            <Badge className="bg-white text-zinc-900 mb-4">Class</Badge>
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-2">
              {plan.title}
            </h1>
            <div className="flex items-center gap-4 text-white/80">
              <span className="text-2xl md:text-3xl font-bold text-white">
                {formatPrice(plan.price)}
              </span>
              <span className="text-white/60">•</span>
              <span>{plan.durationInMonths} months</span>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="w-full max-w-[92%] xl:max-w-[88%] 2xl:max-w-[1600px] mx-auto py-8 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-12">
          {/* Main Content */}
          <motion.div
            className="lg:col-span-2 space-y-8"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {/* Features Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <FeatureItem
                icon={<Calendar className="h-5 w-5" />}
                label="Duration"
                value={`${plan.durationInMonths} months`}
              />
              <FeatureItem
                icon={<Clock className="h-5 w-5" />}
                label="Weekly"
                value={`${plan.meetingsPerWeek} sessions`}
              />
              <FeatureItem
                icon={<Users className="h-5 w-5" />}
                label="Participants"
                value={`${plan.maxParticipants} max`}
              />
              <FeatureItem
                icon={<GraduationCap className="h-5 w-5" />}
                label="Level"
                value={plan.level ?? "All Levels"}
              />
            </div>

            {/* About */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-4">
                  About this Class
                </h2>
                <p className="text-zinc-600 whitespace-pre-line leading-relaxed">
                  {plan.description}
                </p>

                <div className="grid grid-cols-2 gap-4 mt-6 pt-6 border-t border-zinc-100">
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Video className="h-4 w-4 text-zinc-400" />
                    <span>{plan.materialProvided ?? "Zoom"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Globe className="h-4 w-4 text-zinc-400" />
                    <span>{plan.language ?? "English"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Book className="h-4 w-4 text-zinc-400" />
                    <span>{plan.classContents.length} Modules</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-600">
                    <Award className="h-4 w-4 text-zinc-400" />
                    <span>
                      {plan.certificateProvided
                        ? "Certificate Included"
                        : "No Certificate"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* What You'll Learn */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-4">
                  What you&apos;ll learn
                </h2>
                <div className="grid md:grid-cols-2 gap-3">
                  {plan.learningOutcomes.map((outcome: string) => (
                    <div key={outcome} className="flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                      <span className="text-zinc-600">{outcome}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Prerequisites */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-4">
                  Prerequisites
                </h2>
                <p className="text-zinc-600">
                  {plan.prerequisites ??
                    "No prerequisites required. This class is suitable for beginners."}
                </p>
              </CardContent>
            </Card>

            {/* Course Content */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-6">
                  Course Content
                </h2>
                <div className="space-y-4">
                  {plan.classContents.map((content, index) => (
                    <div
                      key={content.id}
                      className="flex items-start gap-4 p-4 bg-zinc-50 rounded-xl hover:bg-zinc-100 transition-colors"
                    >
                      <div className="w-10 h-10 rounded-lg bg-zinc-900 text-white flex items-center justify-center font-semibold text-sm flex-shrink-0">
                        {index + 1}
                      </div>
                      <div>
                        <h3 className="font-semibold text-zinc-900">
                          {content.title}
                        </h3>
                        <p className="text-sm text-zinc-500 mt-1">
                          {content.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Topics */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-4">
                  Topics Covered
                </h2>
                <div className="flex flex-wrap gap-2">
                  {plan.topics.map((topic: Topic) => (
                    <Badge
                      key={topic.id}
                      className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200 px-3 py-1"
                    >
                      {topic.name}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Schedule */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-6">
                  Class Schedule
                </h2>
                {plan.classes && plan.classes.length > 0 ? (
                  <div className="space-y-4">
                    {plan.classes.map((classInstance, classIndex) => (
                      <div
                        key={classInstance.id}
                        className="p-4 border border-zinc-200 rounded-xl"
                      >
                        {plan.classes.length > 1 && (
                          <h3 className="font-medium text-zinc-900 mb-3">
                            Session {classIndex + 1}
                          </h3>
                        )}
                        {classInstance.appointments?.length > 0 ? (
                          classInstance.appointments.map((appointment) => (
                            <div key={appointment.id} className="space-y-2">
                              {appointment.slotsOfAppointment?.length > 0 ? (
                                appointment.slotsOfAppointment.map(
                                  (slot, slotIndex) => {
                                    const startTime = new Date(slot.startsAt);
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

                                    const now = new Date();
                                    const endTime = slot.endsAt
                                      ? new Date(slot.endsAt)
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
                                        className="flex items-center justify-between p-3 bg-zinc-50 rounded-lg"
                                      >
                                        <div className="flex items-center gap-3">
                                          <Play className="w-4 h-4 text-zinc-400" />
                                          <span className="text-sm text-zinc-700">
                                            Session {slotIndex + 1}:{" "}
                                            {formattedStartTime}
                                          </span>
                                        </div>
                                        <Badge
                                          variant={getBadgeVariant(status)}
                                        >
                                          {status}
                                        </Badge>
                                      </div>
                                    );
                                  },
                                )
                              ) : (
                                <p className="text-sm text-zinc-500">
                                  Schedule to be announced
                                </p>
                              )}
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-zinc-500">
                            Schedule to be announced
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-zinc-500">
                    Class schedule to be announced.
                  </p>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Sidebar */}
          <motion.div
            className="lg:col-span-1"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <div className="sticky top-24 space-y-6">
              {/* Instructor Card */}
              <Card className="border-zinc-200 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">Your Instructor</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="relative h-16 w-16 rounded-full overflow-hidden ring-2 ring-zinc-100">
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
                      <h3 className="font-semibold text-zinc-900">
                        {plan.consultantProfile?.user?.name}
                      </h3>
                      <p className="text-sm text-zinc-500">Expert Instructor</p>
                    </div>
                  </div>
                  <p className="text-sm text-zinc-600">
                    An experienced professional dedicated to sharing knowledge
                    and expertise.
                  </p>
                  <Link
                    href={`/explore/experts/${plan.consultantProfile?.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-zinc-900 hover:text-zinc-700 mt-3"
                  >
                    View Full Profile
                    <ArrowLeft className="w-4 h-4 rotate-180" />
                  </Link>
                </CardContent>
              </Card>

              {/* Registration Card */}
              <ClientClassRegistration
                plan={plan}
                maxParticipants={plan.maxParticipants ?? undefined}
                waitlist={plan.classes?.[0]?.waitlist ?? []}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
