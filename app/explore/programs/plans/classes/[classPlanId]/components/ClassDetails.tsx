"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Calendar,
  Clock,
  Users,
  GraduationCap,
  ArrowLeft,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import {
  buildSessionsFromAppointments,
  groupSessionsByWeek,
} from "@/app/explore/programs/plans/schedule-utils";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { useCurrency } from "@/hooks/useCurrency";
import { generateProgramImageUrl } from "@/lib/explore/programs";
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
    <main className="min-h-screen bg-background">
      {/* Hero Banner — cinematic cover with a slow Ken Burns drift */}
      <div className="relative h-[380px] md:h-[460px] w-full overflow-hidden">
        <motion.div
          className="absolute inset-0"
          initial={{ scale: 1.08 }}
          animate={{ scale: 1 }}
          transition={{ duration: 2.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <Image
            src={generateProgramImageUrl(plan.id, 1200, 400, plan.imageUrl)}
            alt="Class cover"
            fill
            className="object-cover"
            priority
          />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/55 to-zinc-950/10" />

        {/* Back Navigation */}
        <div className="absolute top-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-6">
            <Link
              href="/explore/programs"
              className="group inline-flex items-center gap-2 text-sm text-white/80 transition-colors hover:text-white"
            >
              <ArrowLeft className="w-4 h-4 transition-transform duration-300 group-hover:-translate-x-0.5" />
              Back to Programs
            </Link>
          </div>
        </div>

        {/* Title Overlay */}
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 pb-8">
            <Badge className="mb-4 rounded-full border border-white/20 bg-white/10 text-white backdrop-blur-sm">
              Class
            </Badge>
            <h1 className="text-fluid-4xl tracking-tight font-bold text-white mb-3 max-w-3xl text-balance">
              {plan.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-white/80">
              <span className="text-2xl md:text-3xl font-bold text-white">
                {formatPrice(plan.price)}
              </span>
              <span className="text-white/40">·</span>
              <span>{plan.durationInMonths} months</span>
              <span className="text-white/40">·</span>
              <span>{plan.sessionsPerWeek}/week</span>
              <span className="text-white/40">·</span>
              <span>{planLevelLabel(plan.level)}</span>
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
                value={`${plan.sessionsPerWeek} sessions`}
              />
              <FeatureItem
                icon={<Users className="h-5 w-5" />}
                label="Participants"
                value={`${plan.maxParticipants} max`}
              />
              <FeatureItem
                icon={<GraduationCap className="h-5 w-5" />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
            </div>

            {/* Everything between the facts grid and the schedule is the
                shared body — see PlanDetailBody for why these four pages
                stopped each owning a copy. */}
            <PlanDetailBody
              aboutHeading="About this class"
              description={plan.description}
              learningOutcomes={plan.learningOutcomes}
              targetAudience={plan.targetAudience}
              whatsIncluded={plan.whatsIncluded}
              curriculum={plan.classContents}
              curriculumHeading="Course content"
              prerequisites={plan.prerequisites}
              materialProvided={plan.materialProvided}
              faqs={plan.faqs}
              topics={plan.topics}
            />

            {/* Schedule */}
            <Card className="border-border shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-foreground mb-6">
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
                          className="p-4 border border-border rounded-xl"
                        >
                          {plan.classes.length > 1 && (
                            <h3 className="font-medium text-foreground mb-4">
                              Batch {classIndex + 1}
                            </h3>
                          )}
                          {sessions.length > 0 ? (
                            <div className="space-y-4">
                              {Array.from(weeks.entries()).map(
                                ([weekNum, weekSessions]) => (
                                  <div key={weekNum}>
                                    <h4 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider mb-2 px-1">
                                      Week {weekNum}
                                    </h4>
                                    <div className="space-y-2">
                                      {weekSessions.map((session) => (
                                        <div
                                          key={session.appointmentId}
                                          className={`flex items-center justify-between p-3 rounded-lg ${
                                            session.status === "Completed"
                                              ? "bg-muted opacity-60"
                                              : "bg-muted"
                                          }`}
                                        >
                                          <div className="flex items-center gap-3">
                                            <div className="w-7 h-7 rounded-full bg-border text-muted-foreground flex items-center justify-center text-xs font-semibold flex-shrink-0">
                                              {session.sessionNumber}
                                            </div>
                                            <div className="text-sm">
                                              <span className="font-medium text-foreground">
                                                {formatInTimeZone(
                                                  session.sessionStart,
                                                  userTimeZone,
                                                  "EEEE, MMMM d",
                                                )}
                                              </span>
                                              <span className="text-muted-foreground ml-2">
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
                            <p className="text-sm text-muted-foreground">
                              Schedule to be announced
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
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
              <Card className="border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">Your Instructor</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="relative h-16 w-16 rounded-full overflow-hidden ring-2 ring-border">
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
                    <div className="min-w-0">
                      <h3 className="font-semibold text-foreground">
                        {plan.consultantProfile?.user?.name}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Expert Instructor
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    An experienced professional dedicated to sharing knowledge
                    and expertise.
                  </p>
                  <Link
                    href={`/explore/experts/${plan.consultantProfile?.id}`}
                    className="group inline-flex items-center gap-1 text-sm font-medium text-foreground transition-colors hover:text-foreground/70 mt-3"
                  >
                    <span className="link-sweep pb-0.5">View Full Profile</span>
                    <ArrowLeft className="w-4 h-4 rotate-180 transition-transform duration-300 group-hover:translate-x-0.5" />
                  </Link>
                </CardContent>
              </Card>

              {/* Collaborators */}
              {plan.collaborators && plan.collaborators.length > 0 && (
                <Card className="border-border shadow-sm">
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
                        className="flex items-center gap-3 hover:bg-muted rounded-lg p-2 -mx-2 transition-colors"
                      >
                        <div className="relative h-10 w-10 rounded-full overflow-hidden ring-2 ring-border flex-shrink-0">
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
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {collab.consultantProfile.user.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
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
                consultantUserId={plan.consultantProfile?.user?.id}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
