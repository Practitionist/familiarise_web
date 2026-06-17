"use client";

import { useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
// #248: do NOT statically import the Stream SDK (useStreamVideoClient) or
// lib/meeting (which imports the SDK) here — that would pull the heavy SDK into
// the dashboard-HOME bundle / critical path. The video client + meeting helper
// are acquired lazily inside the Join handler (only when a user clicks Join).
import { getGlobalVideoClient } from "@/lib/stream/disconnect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { DataCard, EmptyState } from "@/components/dashboard/DataCard";
import {
  Calendar,
  Clock,
  Video,
  ChevronRight,
  FileText,
  Building2,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  calculateSessionProgress,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeImage,
  getConsumeeName,
  getStartTime,
  getNextUpcomingSlotTime,
  groupRecurringAppointments,
  sortAppointmentsByStartTime,
  getTodayAppointments,
  getUpcomingAppointments,
  getCollaboratorRole,
  formatCollaboratorRole,
  getRoleBadgeStyle,
} from "../../utils/appointmentHelpers";

import { getBadgeStyle } from "../../types";
import { TAppointment } from "@/types/appointment";
import { getJoinableSlot } from "../../utils/joinState";
import { getInitials } from "@/utils/formatting";
import { RequestSlotAllocationTabMini } from "../requests/RequestSlotAllocationTabMini";
import { PerformanceSnapshot } from "./PerformanceSnapshot";
import { FinancialSummary } from "./FinancialSummary";
import type {
  TPerformanceSnapshot,
  TFinancialSummary,
} from "@/types/consultant-events";

interface HomeTabProps {
  appointments: TAppointment[];
  consultantId: string;
  consultantName?: string;
  pendingRequestsCount?: number;
  performanceSnapshot?: TPerformanceSnapshot;
  financialSummary?: TFinancialSummary;
}

// #248: the video connect is deferred to requestIdleCallback, so the global
// client may not exist yet at the instant a user clicks Join. Poll briefly for
// it (the StreamProvider mounted on this route is already connecting) rather
// than erroring out on the first null read. Resolves null if it never appears
// within the window so the caller can show a soft "try again" message.
async function waitForGlobalVideoClient(
  timeoutMs = 4000,
  intervalMs = 150,
): Promise<ReturnType<typeof getGlobalVideoClient>> {
  const existing = getGlobalVideoClient();
  if (existing) return existing;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const client = getGlobalVideoClient();
    if (client) return client;
  }
  return getGlobalVideoClient();
}

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export function HomeTab({
  appointments,
  consultantId,
  consultantName,
  pendingRequestsCount = 0,
  performanceSnapshot,
  financialSummary,
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: session } = useSession();
  // Sponsoring-org lookup for the indigo "Sponsored · <Org>" badge —
  // shows on org-funded appointments only, mirroring the consultee
  // dashboard convention.
  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoringOrgName = (
    orgId: string | null | undefined,
  ): string | null => {
    if (!orgId) return null;
    return (
      orgMemberships.find((m) => m.organizationId === orgId)?.organizationName ??
      "the organization"
    );
  };

  const handleJoinMeeting = async (
    appointment: TAppointment,
    joinableSlot?: TAppointment["slotsOfAppointment"][number],
  ) => {
    // #248: read the already-connected video client singleton at click time
    // (same instance <StreamVideo> uses) instead of via useStreamVideoClient,
    // so the SDK stays off the home bundle. The video connect is now deferred
    // to requestIdleCallback, so a fast Join click can land before the client
    // exists — briefly wait for it instead of immediately erroring.
    const client = await waitForGlobalVideoClient();
    if (!client) {
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
      });
      return;
    }
    const relevantSlot =
      joinableSlot ?? appointment.slotsOfAppointment?.[0];
    if (!relevantSlot) {
      toast({
        title: "Error",
        description: "Slot information missing.",
      });
      return;
    }

    try {
      // #248: lazy-import the meeting helper (it imports the SDK) on demand.
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        relevantSlot,
      );
      router.push(`/meetings/${meetingId}`);
    } catch (_error) {
      toast({
        title: "Error",
        description: "Failed to join meeting.",
        variant: "destructive",
      });
    }
  };

  const expandedAppointments = useMemo(() => appointments || [], [appointments]);

  const APPOINTMENT_DISPLAY_LIMIT = 8;

  const allTodayAppointments = useMemo(
    () =>
      getTodayAppointments(expandedAppointments).filter(
        (appointment) => getAppointmentStatus(appointment) !== "Completed",
      ),
    [expandedAppointments],
  );

  const todayAppointments = useMemo(
    () => allTodayAppointments.slice(0, APPOINTMENT_DISPLAY_LIMIT),
    [allTodayAppointments],
  );

  const allUpcomingAppointments = useMemo(
    () =>
      sortAppointmentsByStartTime(
        getUpcomingAppointments(expandedAppointments),
      ),
    [expandedAppointments],
  );

  const upcomingGroups = useMemo(() => {
    const groupedAll = groupRecurringAppointments(allUpcomingAppointments);
    return Object.entries(groupedAll)
      .sort(([keyA, aptsA], [keyB, aptsB]) => {
        const isRecurringA =
          keyA.startsWith("subscription-") || keyA.startsWith("class-");
        const isRecurringB =
          keyB.startsWith("subscription-") || keyB.startsWith("class-");
        const timeA = isRecurringA
          ? getNextUpcomingSlotTime(aptsA[0])
          : getStartTime(aptsA[0]);
        const timeB = isRecurringB
          ? getNextUpcomingSlotTime(aptsB[0])
          : getStartTime(aptsB[0]);
        if (!timeA && !timeB) return 0;
        if (!timeA) return 1;
        if (!timeB) return -1;
        return timeA.getTime() - timeB.getTime();
      })
      .slice(0, 5);
  }, [allUpcomingAppointments]);

  const firstName = consultantName?.split(" ")[0];

  return (
    <>
      <DashboardHeader
        title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        subtitle="Here's what's happening with your appointments today"
      />

      <DashboardContent>
        <motion.div
          variants={staggerChildren}
          initial="hidden"
          animate="visible"
          className="space-y-6"
        >
          {/* Performance Snapshot */}
          {performanceSnapshot && (
            <motion.div variants={fadeInUp}>
              <PerformanceSnapshot {...performanceSnapshot} />
            </motion.div>
          )}

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Left Column - Today's Appointments + Upcoming Sessions */}
            <motion.div variants={fadeInUp} className="lg:col-span-3 space-y-6">
              {/* Today's Appointments */}
              <DataCard
                title="Today's Appointments"
                icon={Calendar}
                viewAllLink={`/dashboard/consultant/${consultantId}/appointments`}
              >
                {todayAppointments.length > 0 ? (
                  <div className="divide-y divide-zinc-100">
                    {todayAppointments.map((appointment) => {
                      const userName = getConsumeeName(appointment);
                      const status = getAppointmentStatus(appointment);
                      const startTime = getStartTime(appointment);
                      const joinableSlot = getJoinableSlot(
                        appointment.slotsOfAppointment ?? [],
                      );
                      const isJoinable = joinableSlot !== null;
                      const isDev =
                        process.env.NODE_ENV !== "production";

                      return (
                        <div
                          key={appointment.id}
                          className="flex items-center gap-4 py-3 first:pt-0 last:pb-0 hover:bg-zinc-50/50 -mx-5 px-5 transition-colors"
                        >
                          <Avatar className="h-10 w-10 flex-shrink-0 ring-2 ring-white shadow-sm">
                            <AvatarImage
                              alt={userName}
                              src={getConsumeeImage(appointment)}
                            />
                            <AvatarFallback className="bg-zinc-100 text-zinc-600 font-medium text-sm">
                              {getInitials(userName)}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-medium text-zinc-900 truncate text-sm">
                                {userName}
                              </h3>
                              {(() => {
                                const sponsoringOrgName =
                                  resolveSponsoringOrgName(
                                    appointment.organizationId,
                                  );
                                return sponsoringOrgName ? (
                                  <Badge
                                    className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                                    title={`Sponsored by ${sponsoringOrgName}`}
                                  >
                                    <Building2 className="h-3 w-3 shrink-0" />
                                    <span className="truncate">
                                      Sponsored · {sponsoringOrgName}
                                    </span>
                                  </Badge>
                                ) : null;
                              })()}
                              {(() => {
                                const role = getCollaboratorRole(
                                  appointment,
                                  consultantId,
                                );
                                return role ? (
                                  <Badge
                                    className={`text-[10px] px-1.5 py-0 h-5 flex-shrink-0 ${getRoleBadgeStyle(role)}`}
                                  >
                                    {formatCollaboratorRole(role)}
                                  </Badge>
                                ) : null;
                              })()}
                            </div>
                            <p className="text-xs text-zinc-500 truncate">
                              {getAppointmentTypeAndPlan(appointment)}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 text-sm text-zinc-500 flex-shrink-0">
                            <Clock className="h-3.5 w-3.5" />
                            <span>
                              {startTime
                                ? formatAppointmentTime(startTime.toISOString())
                                : "TBD"}
                            </span>
                          </div>

                          <Badge
                            className={`flex-shrink-0 ${getBadgeStyle(status)}`}
                          >
                            {status}
                          </Badge>

                          {(isDev || isJoinable) && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    onClick={() =>
                                      handleJoinMeeting(
                                        appointment,
                                        joinableSlot ?? undefined,
                                      )
                                    }
                                    className="flex-shrink-0 bg-zinc-900 hover:bg-zinc-800 text-white gap-1.5"
                                    size="sm"
                                    disabled={isDev ? false : !isJoinable}
                                  >
                                    <Video className="h-3.5 w-3.5" />
                                    {isDev
                                      ? "Join (Dev)"
                                      : "Join"}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Join the meeting room</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      );
                    })}
                    {allTodayAppointments.length > APPOINTMENT_DISPLAY_LIMIT && (
                      <div className="pt-3 text-center">
                        <Link
                          href={`/dashboard/consultant/${consultantId}/appointments`}
                          className="text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
                        >
                          View all {allTodayAppointments.length} appointments
                        </Link>
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    icon={Calendar}
                    title="No appointments today"
                    description="Enjoy your free time or check upcoming sessions"
                    action={
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/dashboard/consultant/${consultantId}/planner`}>
                            Set up availability
                          </Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/dashboard/consultant/${consultantId}/appointments`}>
                            View all appointments
                          </Link>
                        </Button>
                      </div>
                    }
                  />
                )}
              </DataCard>

              {/* Upcoming Sessions */}
              <DataCard
                title="Upcoming Sessions"
                icon={Clock}
                viewAllLink={`/dashboard/consultant/${consultantId}/appointments`}
                viewAllText="View all appointments"
              >
                {upcomingGroups.length > 0 ? (
                  <div className="space-y-3">
                    {upcomingGroups.map(([groupKey, groupAppointments]) => {
                      const isRecurring =
                        groupKey.startsWith("subscription-") ||
                        groupKey.startsWith("class-");
                      const firstAppointment = groupAppointments[0];
                      const userName = getConsumeeName(firstAppointment);
                      const status = getAppointmentStatus(firstAppointment);
                      const startTime = isRecurring
                        ? getNextUpcomingSlotTime(firstAppointment)
                        : getStartTime(firstAppointment);

                      const {
                        completedSessions,
                        totalSessions,
                        progressPercentage,
                      } = calculateSessionProgress(groupAppointments);

                      return (
                        <motion.div
                          key={groupKey}
                          whileHover={{ x: 4 }}
                          className="group flex items-center gap-4 p-3 rounded-xl hover:bg-zinc-50 cursor-pointer transition-all"
                          onClick={() =>
                            router.push(
                              `/dashboard/consultant/${consultantId}/appointments?highlight=${encodeURIComponent(groupKey)}`,
                            )
                          }
                        >
                          <Avatar className="h-10 w-10">
                            <AvatarImage
                              alt={userName}
                              src={getConsumeeImage(firstAppointment)}
                            />
                            <AvatarFallback className="bg-zinc-100 text-zinc-600 text-sm">
                              {getInitials(userName)}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="font-medium text-zinc-900 truncate">
                                {userName}
                              </h4>
                              {(() => {
                                const sponsoringOrgName =
                                  resolveSponsoringOrgName(
                                    firstAppointment.organizationId,
                                  );
                                return sponsoringOrgName ? (
                                  <Badge
                                    className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                                    title={`Sponsored by ${sponsoringOrgName}`}
                                  >
                                    <Building2 className="h-3 w-3 shrink-0" />
                                    <span className="truncate">
                                      Sponsored · {sponsoringOrgName}
                                    </span>
                                  </Badge>
                                ) : null;
                              })()}
                              {(() => {
                                const role = getCollaboratorRole(
                                  firstAppointment,
                                  consultantId,
                                );
                                return role ? (
                                  <Badge
                                    className={`text-[10px] px-1.5 py-0 h-5 flex-shrink-0 ${getRoleBadgeStyle(role)}`}
                                  >
                                    {formatCollaboratorRole(role)}
                                  </Badge>
                                ) : null;
                              })()}
                              {isRecurring && (
                                <span className="text-xs text-zinc-400">
                                  {completedSessions}/{totalSessions} sessions
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-zinc-500">
                              {startTime
                                ? formatAppointmentTime(startTime.toISOString())
                                : "TBD"}
                            </p>
                            {isRecurring && (
                              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-100">
                                <div
                                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-blue-500 transition-all"
                                  style={{ width: `${progressPercentage}%` }}
                                />
                              </div>
                            )}
                          </div>

                          <Badge className={getBadgeStyle(status)}>
                            {status}
                          </Badge>

                          <ChevronRight className="h-5 w-5 text-zinc-300 group-hover:text-zinc-500 transition-colors" />
                        </motion.div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    icon={Clock}
                    title="No upcoming appointments"
                    description="Your schedule is clear for now"
                    action={
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/dashboard/consultant/${consultantId}/planner`}>
                          Set up availability
                        </Link>
                      </Button>
                    }
                  />
                )}
              </DataCard>
            </motion.div>

            {/* Right Column - Pending Requests + Financial Summary */}
            <motion.div variants={fadeInUp} className="lg:col-span-2 space-y-6">
              {/* Pending Requests */}
              <DataCard
                title="Pending Requests"
                icon={FileText}
                headerAction={
                  pendingRequestsCount > 0 ? (
                    <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
                      {pendingRequestsCount}
                    </Badge>
                  ) : undefined
                }
                viewAllLink={`/dashboard/consultant/${consultantId}/requests`}
                viewAllText="View all requests"
              >
                <div className="max-h-[300px] overflow-y-auto -mx-5 px-5">
                  <RequestSlotAllocationTabMini />
                </div>
              </DataCard>

              {/* Financial Summary */}
              {financialSummary && (
                <FinancialSummary {...financialSummary} />
              )}
            </motion.div>
          </div>
        </motion.div>
      </DashboardContent>
    </>
  );
}
