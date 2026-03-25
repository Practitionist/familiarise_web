"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import {
  buildSessionsFromAppointments,
  groupSessionsByWeek,
} from "@/app/explore/programs/plans/schedule-utils";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { useCurrency } from "@/hooks/useCurrency";
import type { Topic } from "@prisma/client";
import { generateProgramImageUrl } from "@/app/explore/programs/utils";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";
import type { TClassPlanDetailsData } from "../types";

const getBadgeVariant = (
  currentStatus: string,
): "outline" | "destructive" | "default" => {
  if (currentStatus === "Completed") return "outline";
  if (currentStatus === "Happening Now") return "destructive";
  return "default";
};

interface ClassDetailsProps {
  readonly plan: TClassPlanDetailsData;
}

export function ClassDetails({ plan }: ClassDetailsProps) {
  const { formatPrice } = useCurrency();
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50">
      {/* Hero Banner */}
      <div className="relative h-[350px] md:h-[400px] w-full overflow-hidden">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 400, plan.imageUrl)}
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
                  <div className="space-y-6">
                    {plan.classes.map((classInstance, classIndex) => {
                      const sessions = buildSessionsFromAppointments(
                        classInstance.appointments ?? [],
                      );
                      const weeks = groupSessionsByWeek(sessions);

                      return (
                        <div
                          key={classInstance.id}
                          className="p-4 border border-zinc-200 rounded-xl"
                        >
                          {plan.classes.length > 1 && (
                            <h3 className="font-medium text-zinc-900 mb-4">
                              Batch {classIndex + 1}
                            </h3>
                          )}
                          {sessions.length > 0 ? (
                            <div className="space-y-4">
                              {Array.from(weeks.entries()).map(
                                ([weekNum, weekSessions]) => (
                                  <div key={weekNum}>
                                    <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 px-1">
                                      Week {weekNum}
                                    </h4>
                                    <div className="space-y-2">
                                      {weekSessions.map((session) => (
                                        <div
                                          key={session.appointmentId}
                                          className={`flex items-center justify-between p-3 rounded-lg ${
                                            session.status === "Completed"
                                              ? "bg-zinc-50 opacity-60"
                                              : "bg-zinc-50"
                                          }`}
                                        >
                                          <div className="flex items-center gap-3">
                                            <div className="w-7 h-7 rounded-full bg-zinc-200 text-zinc-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                                              {session.sessionNumber}
                                            </div>
                                            <div className="text-sm">
                                              <span className="font-medium text-zinc-800">
                                                {formatInTimeZone(
                                                  session.sessionStart,
                                                  userTimeZone,
                                                  "EEEE, MMMM d",
                                                )}
                                              </span>
                                              <span className="text-zinc-500 ml-2">
                                                {formatInTimeZone(
                                                  session.sessionStart,
                                                  userTimeZone,
                                                  "h:mm a",
                                                )}
                                                {" – "}
                                                {formatInTimeZone(
                                                  session.sessionEnd,
                                                  userTimeZone,
                                                  "h:mm a zzz",
                                                )}
                                              </span>
                                            </div>
                                          </div>
                                          <Badge
                                            variant={getBadgeVariant(
                                              session.status,
                                            )}
                                          >
                                            {session.status}
                                          </Badge>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ),
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-zinc-500">
                              Schedule to be announced
                            </p>
                          )}
                        </div>
                      );
                    })}
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

              {/* Collaborators */}
              {plan.collaborators && plan.collaborators.length > 0 && (
                <Card className="border-zinc-200 shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Users className="w-4 h-4" />
                      Co-Instructors
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {plan.collaborators.map((collab) => (
                      <Link
                        key={collab.id}
                        href={`/explore/experts/${collab.consultantProfile.id}`}
                        className="flex items-center gap-3 hover:bg-zinc-50 rounded-lg p-2 -mx-2 transition-colors"
                      >
                        <div className="relative h-10 w-10 rounded-full overflow-hidden ring-2 ring-zinc-100">
                          <Image
                            src={
                              collab.consultantProfile.user.image ??
                              "/placeholder-user.jpg"
                            }
                            alt={
                              collab.consultantProfile.user.name ??
                              "Co-instructor"
                            }
                            fill
                            className="object-cover"
                          />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-zinc-900">
                            {collab.consultantProfile.user.name}
                          </p>
                          <p className="text-xs text-zinc-500">
                            {collab.role.replace(/_/g, " ")}
                          </p>
                        </div>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Registration Card */}
              <ClientClassRegistration
                plan={plan}
                maxParticipants={plan.maxParticipants ?? undefined}
                waitlist={plan.classes?.[0]?.waitlist ?? []}
                consultantUserId={plan.consultantProfile?.user?.id}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
