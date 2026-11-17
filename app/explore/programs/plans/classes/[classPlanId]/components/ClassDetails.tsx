"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Calendar, Clock, Users, GraduationCap, ArrowLeft } from "lucide-react";
import { deriveBatchCards } from "@/lib/booking/batch-cards";
import {
  CoHostList,
  hasPublicExpertPage,
} from "@/app/explore/programs/plans/components/CoHostList";
import { BatchSchedule } from "./BatchSchedule";
import { ClientClassRegistration } from "./ClientClassRegistration";
import { BuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import { generateProgramImageUrl } from "@/lib/explore/programs";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";
import type { TClassPlanDetailsData } from "../types";

interface ClassDetailsProps {
  readonly plan: TClassPlanDetailsData;
  /** Batches' appointments the signed-in viewer holds a seat on; read by the server. */
  readonly enrolledAppointmentIds: readonly string[];
  /** Batches' appointments the viewer is on the notify-me list of; read by the server. */
  readonly waitingAppointmentIds: readonly string[];
  /** Who the server rendered for, so the client can refresh on a mismatch. */
  readonly viewerUserId: string | null;
}

export function ClassDetails({
  plan,
  enrolledAppointmentIds,
  waitingAppointmentIds,
  viewerUserId,
}: ClassDetailsProps) {
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  // #1819 — one derivation for the batch list and the registration card.
  const cards = useMemo(
    () =>
      deriveBatchCards(plan, plan.classes, new Date(), {
        timeZone: userTimeZone,
      }),
    [plan, userTimeZone],
  );

  return (
    <main className="min-h-screen bg-muted">
      {/* Hero Banner */}
      <div className="relative h-[350px] md:h-[400px] w-full overflow-hidden">
        <Image
          src={generateProgramImageUrl(plan.imageUrl)}
          alt="Class cover"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />

        {/* Title Overlay */}
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 pb-8">
            <Badge className="bg-background text-foreground mb-4">Class</Badge>
            <h1 className="text-fluid-4xl tracking-tight font-bold text-white mb-2">
              {plan.title}
            </h1>
            <div className="flex items-center gap-4 text-white/80">
              <span className="text-2xl md:text-3xl font-bold text-white">
                <BuyerPrice paise={plan.price} noteClassName="text-white/70" />
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
              filesIncluded={plan.materials}
              faqs={plan.faqs}
              topics={plan.topics}
            />

            {/* Schedule */}
            <Card className="border-border shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-foreground mb-6">
                  Class Schedule
                </h2>
                <BatchSchedule
                  plan={plan}
                  cards={cards}
                  zone={userTimeZone}
                  enrolledAppointmentIds={enrolledAppointmentIds}
                  waitingAppointmentIds={waitingAppointmentIds}
                  viewerUserId={viewerUserId}
                />
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
                  {hasPublicExpertPage(plan.consultantProfile) && (
                    <Link
                      href={`/explore/experts/${plan.consultantProfile?.id}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-muted-foreground mt-3"
                    >
                      View Full Profile
                      <ArrowLeft className="w-4 h-4 rotate-180" />
                    </Link>
                  )}
                </CardContent>
              </Card>

              <CoHostList
                title="Co-Instructors"
                unnamed="Co-instructor"
                collaborators={plan.collaborators}
                className="border-border shadow-sm"
              />

              {/* Registration Card */}
              <ClientClassRegistration
                plan={plan}
                maxParticipants={plan.maxParticipants ?? undefined}
                enrolledAppointmentIds={enrolledAppointmentIds}
                waitingAppointmentIds={waitingAppointmentIds}
                viewerUserId={viewerUserId}
                waitlistEnabled={plan.waitlistEnabled}
                batch={cards.find((c) => c.canEnrol) ?? cards[0]}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
