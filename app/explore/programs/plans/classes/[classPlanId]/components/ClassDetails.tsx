"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import { Calendar, Clock, Users, GraduationCap, ArrowLeft } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import {
  buildSessionsFromAppointment,
  groupSessionsByWeek,
} from "@/app/explore/programs/plans/schedule-utils";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { useCurrency } from "@/hooks/useCurrency";
import { generateProgramImageUrl } from "@/lib/explore/programs";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";
import { MobileBookingBar } from "@/app/explore/components/MobileBookingBar";
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
    <main className="explore-detail min-h-screen">
      {/* Hero Banner */}
      <div className="relative h-[330px] w-full overflow-hidden md:h-[390px]">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 400, plan.imageUrl)}
          alt="Class cover"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/75 to-zinc-950/15" />

        {/* Back Navigation */}
        <div className="absolute top-0 left-0 right-0 z-10">
          <div className="explore-detail-shell py-6">
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
          <div className="explore-detail-shell pb-8">
            <Badge className="bg-background text-foreground mb-4">Class</Badge>
            <h1 className="max-w-4xl text-fluid-4xl font-semibold tracking-tight text-white mb-3">
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
      <div className="explore-detail-shell py-8 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-12">
          {/* Main Content */}
          <div className="space-y-8 lg:col-span-2">
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
            <Card className="rounded-2xl border-border shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-foreground mb-6">
                  Class Schedule
                </h2>
                {plan.classes && plan.classes.length > 0 ? (
                  <div className="space-y-6">
                    {plan.classes.map((classInstance, classIndex) => {
                      const sessions = buildSessionsFromAppointment(
                        classInstance.appointment,
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
          </div>

          {/* Sidebar */}
          <div className="lg:col-span-1">
            <div className="flex flex-col gap-6 lg:sticky lg:top-[calc(var(--maintenance-banner-height,0px)+var(--header-height,5rem)+1rem)]">
              {/* Registration Card */}
              <div id="class-booking" className="explore-booking-target">
                <ClientClassRegistration
                  plan={plan}
                  maxParticipants={plan.maxParticipants ?? undefined}
                  consultantUserId={plan.consultantProfile?.user?.id}
                />
              </div>

              {/* Instructor Card */}
              <Card className="rounded-2xl border-border shadow-sm">
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
                    className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-muted-foreground mt-3"
                  >
                    View Full Profile
                    <ArrowLeft className="w-4 h-4 rotate-180" />
                  </Link>
                </CardContent>
              </Card>

              {/* Collaborators */}
              {plan.collaborators && plan.collaborators.length > 0 && (
                <Card className="rounded-2xl border-border shadow-sm">
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
            </div>
          </div>
        </div>
      </div>
      <MobileBookingBar
        targetId="class-booking"
        context="Class registration"
        label={formatPrice(plan.price)}
      />
    </main>
  );
}
