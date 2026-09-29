"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanHero } from "../../../components/PlanHero";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Calendar, Clock, Users, GraduationCap, ArrowLeft } from "lucide-react";
import { deriveBatchCards } from "@/lib/booking/batch-cards";
import { formatRole } from "@/components/collaborators/format";
import { BatchSchedule } from "./BatchSchedule";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { useCurrency } from "@/hooks/useCurrency";
import { generateProgramImageUrl } from "@/lib/explore/programs";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";
import type { TClassPlanDetailsData } from "../types";

interface ClassDetailsProps {
  readonly plan: TClassPlanDetailsData;
}

export function ClassDetails({ plan }: ClassDetailsProps) {
  const { formatPrice } = useCurrency();
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  // #1819 — one derivation for the batch list and the registration card.
  const hostUserId = plan.consultantProfile?.user?.id;
  const cards = useMemo(
    () =>
      deriveBatchCards(plan, plan.classes, new Date(), {
        timeZone: userTimeZone,
        hostUserId,
      }),
    [plan, userTimeZone, hostUserId],
  );

  return (
    <main className="explore-page min-h-screen pb-24 lg:pb-0">
      <PlanHero
        title={plan.title}
        image={generateProgramImageUrl(plan.id, 700, 500, plan.imageUrl)}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Class</Badge>
        </div>
        <p className="mt-4 text-lg font-medium">
          {formatPrice(plan.price)}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            · {plan.durationInMonths} month
            {plan.durationInMonths === 1 ? "" : "s"}
          </span>
        </p>
      </PlanHero>

      {/* Content */}
      <div className="explore-container py-8 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-12">
          {/* Main Content */}
          <motion.div
            className="lg:col-span-2 space-y-8"
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {/* Features Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <FeatureItem
                icon={<Calendar className="h-5 w-5" />}
                label="Duration"
                value={`${plan.durationInMonths} month${plan.durationInMonths === 1 ? "" : "s"}`}
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
                <BatchSchedule plan={plan} cards={cards} zone={userTimeZone} />
              </CardContent>
            </Card>
          </motion.div>

          {/* Sidebar */}
          <motion.div
            className="lg:col-span-1"
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <div className="lg:sticky lg:top-[calc(var(--header-height,5rem)+var(--maintenance-banner-height,0px)+1.5rem)] space-y-6">
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
                            {formatRole(collab.role)}
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
                batch={cards.find((c) => c.canEnrol) ?? cards[0]}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
