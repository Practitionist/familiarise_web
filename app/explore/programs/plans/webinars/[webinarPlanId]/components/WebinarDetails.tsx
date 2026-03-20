"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  CheckCircle2,
  Calendar,
  Clock,
  Users,
  Video,
  Globe,
  GraduationCap,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { ClientWebinarRegistration } from "./ClientWebinarRegistration";
import { generateProgramImageUrl } from "../../../../utils";
import { useCurrency } from "@/hooks/useCurrency";
import type { Topic } from "@prisma/client";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";
import type { TWebinarPlanData, TSessionStatus } from "../types";

interface WebinarDetailsProps {
  readonly plan: TWebinarPlanData;
  readonly nextSession: Date | string | undefined;
  readonly webinarId?: string;
}

export function WebinarDetails({
  plan,
  nextSession,
  webinarId,
}: WebinarDetailsProps) {
  const { formatPrice } = useCurrency();
  let sessionStatus: TSessionStatus = "To be announced";
  let formattedNextSessionDisplay = "To be announced";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (
    nextSession &&
    plan.durationInHours !== null &&
    plan.durationInHours !== undefined
  ) {
    const sessionStart = new Date(nextSession);
    const durationInMilliseconds = plan.durationInHours * 60 * 60 * 1000;
    const sessionEnd = new Date(
      sessionStart.getTime() + durationInMilliseconds,
    );
    const now = new Date();

    if (now > sessionEnd) {
      sessionStatus = "Completed";
      formattedNextSessionDisplay = `Ended on ${formatInTimeZone(sessionEnd, timeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`;
    } else if (now >= sessionStart && now <= sessionEnd) {
      sessionStatus = "Happening Now";
      formattedNextSessionDisplay = `Ends at ${formatInTimeZone(sessionEnd, timeZone, "h:mm a zzz")}`;
    } else if (now < sessionStart) {
      sessionStatus = "Upcoming";
      formattedNextSessionDisplay = formatInTimeZone(sessionStart, timeZone, "MMMM d, yyyy 'at' h:mm a zzz");
    }
  } else if (nextSession) {
    sessionStatus = "Upcoming";
    formattedNextSessionDisplay = formatInTimeZone(new Date(nextSession), timeZone, "MMMM d, yyyy 'at' h:mm a zzz");
  }

  const getStatusBadgeClass = (status: TSessionStatus) => {
    switch (status) {
      case "Happening Now":
        return "bg-emerald-500 text-white";
      case "Completed":
        return "bg-zinc-200 text-zinc-600";
      case "Upcoming":
        return "bg-zinc-900 text-white";
      default:
        return "bg-zinc-100 text-zinc-600";
    }
  };

  return (
    <main className="min-h-screen bg-zinc-50">
      {/* Hero Banner */}
      <div className="relative h-[350px] md:h-[400px] w-full overflow-hidden">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 400, plan.imageUrl)}
          alt="Webinar cover"
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
            <div className="flex items-center gap-3 mb-4">
              <Badge className="bg-white text-zinc-900">Webinar</Badge>
              <Badge className={getStatusBadgeClass(sessionStatus)}>
                {sessionStatus}
              </Badge>
            </div>
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-2">
              {plan.title}
            </h1>
            <div className="flex items-center gap-4 text-white/80">
              <span className="text-2xl md:text-3xl font-bold text-white">
                {formatPrice(plan.price)}
              </span>
              <span className="text-white/60">•</span>
              <span>{plan.durationInHours} hours</span>
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
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <FeatureItem
                icon={<Calendar className="h-5 w-5" />}
                label={
                  sessionStatus === "Happening Now" ||
                  sessionStatus === "Completed"
                    ? "Status"
                    : "Next Session"
                }
                value={formattedNextSessionDisplay}
              />
              <FeatureItem
                icon={<Clock className="h-5 w-5" />}
                label="Duration"
                value={`${plan.durationInHours} hours`}
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
            </div>

            {/* About */}
            <Card className="border-zinc-200 shadow-sm">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-xl font-semibold text-zinc-900 mb-4">
                  About this Webinar
                </h2>
                <p className="text-zinc-600 whitespace-pre-line leading-relaxed">
                  {plan.description}
                </p>
              </CardContent>
            </Card>

            {/* What You'll Learn */}
            {plan.learningOutcomes && plan.learningOutcomes.length > 0 && (
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
            )}

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
                  <CardTitle className="text-lg">Your Host</CardTitle>
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
                      <p className="text-sm text-zinc-500">Expert Host</p>
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
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Users className="w-4 h-4" />
                      Co-Hosts
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
                              collab.consultantProfile.user.name ?? "Co-host"
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
              <ClientWebinarRegistration
                webinarPlanId={plan.id}
                webinarId={webinarId}
                price={plan.price}
                currency={plan.priceCurrency}
                nextSessionDate={
                  nextSession ? new Date(nextSession) : undefined
                }
                sessionStatus={sessionStatus}
                appointment={plan.webinars?.[0]?.appointment}
                maxParticipants={plan.maxParticipants ?? 100}
                waitlist={plan.webinars?.[0]?.waitlist ?? []}
                consultantUserId={plan.consultantProfile?.user?.id}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
