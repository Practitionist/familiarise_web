"use client";

import { useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import { DataCard, EmptyState } from "@/components/dashboard/DataCard";
import {
  Calendar,
  Clock,
  Users,
  Video,
  TrendingUp,
  ChevronRight,
  FileText,
  Bell,
  BarChart3,
  DollarSign,
  CheckCircle2,
  Wallet,
  Info,
} from "lucide-react";
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
import { getInitials, formatCurrencyAmount } from "@/utils/formatting";
import { RequestSlotAllocationTabMini } from "../requests/RequestSlotAllocationTabMini";

interface HomeTabProps {
  appointments: TAppointment[];
  consultantId: string;
  consultantName?: string;
  pendingRequestsCount?: number;
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

interface EarningsResponse {
  summary: {
    totalEarnings: number;
    pendingEarnings: number;
    readyEarnings: number;
    paidEarnings: number;
    heldEarnings: number;
  };
  eligibility: {
    isEligible: boolean;
    readyAmount: number;
    minimumAmount: number;
  };
}

function QuickStatsPanel({
  appointments,
  consultantId,
}: {
  appointments: TAppointment[];
  consultantId: string;
}) {
  const activeClients = useMemo(() => {
    const consulteeIds = new Set<string>();
    for (const apt of appointments) {
      const status = getAppointmentStatus(apt);
      if (status !== "Completed" && status !== "Cancelled") {
        const id =
          apt.consultation?.requestedBy?.id ??
          apt.subscription?.requestedBy?.id;
        if (id) consulteeIds.add(id);
      }
    }
    return consulteeIds.size;
  }, [appointments]);

  const completedThisMonth = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return (appointments || []).filter((apt) => {
      const status = getAppointmentStatus(apt);
      if (status !== "Completed") return false;
      const startTime = getStartTime(apt);
      if (!startTime) return false;
      return startTime >= startOfMonth && startTime <= now;
    }).length;
  }, [appointments]);

  const activePrograms = useMemo(() => {
    const subscriptionIds = new Set<string>();
    const classIds = new Set<string>();
    for (const apt of appointments) {
      const status = getAppointmentStatus(apt);
      if (status === "Completed" || status === "Cancelled") continue;
      if (apt.subscription?.id) subscriptionIds.add(apt.subscription.id);
      if (apt.class?.id) classIds.add(apt.class.id);
    }
    return subscriptionIds.size + classIds.size;
  }, [appointments]);

  const { data: earningsData } = useQuery<EarningsResponse>({
    queryKey: ["consultant-earnings-summary", consultantId],
    queryFn: async () => {
      const res = await fetch("/api/consultant/earnings?limit=0");
      if (!res.ok) throw new Error(`Earnings fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  const formatCurrency = (amount: number) => formatCurrencyAmount(amount, "INR");

  return (
    <DataCard title="Business Overview" icon={BarChart3}>
      <TooltipProvider>
        <div className="divide-y divide-zinc-100">
          <div className="flex items-center justify-between py-3 first:pt-0">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-blue-50 flex items-center justify-center">
                <Users className="h-4 w-4 text-blue-600" />
              </div>
              <span className="text-sm text-zinc-600">Active Clients</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-zinc-400 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Unique clients with ongoing appointments (excludes completed and cancelled)</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <span className="text-lg font-semibold text-zinc-900">
              {activeClients}
            </span>
          </div>

          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                <Calendar className="h-4 w-4 text-indigo-600" />
              </div>
              <span className="text-sm text-zinc-600">Active Programs</span>
            </div>
            <span className="text-lg font-semibold text-zinc-900">
              {activePrograms}
            </span>
          </div>

          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                <DollarSign className="h-4 w-4 text-emerald-600" />
              </div>
              <span className="text-sm text-zinc-600">Net Earnings</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-zinc-400 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Total earnings excluding refunded amounts</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <span className="text-lg font-semibold text-zinc-900">
              {earningsData?.summary
                ? formatCurrency(earningsData.summary.totalEarnings)
                : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-amber-50 flex items-center justify-center">
                <Wallet className="h-4 w-4 text-amber-600" />
              </div>
              <span className="text-sm text-zinc-600">Next Payout</span>
            </div>
            <div className="text-right">
              <span className="text-lg font-semibold text-zinc-900">
                {earningsData?.eligibility
                  ? formatCurrency(earningsData.eligibility.readyAmount)
                  : "—"}
              </span>
              {earningsData?.eligibility && (
                <div className="flex items-center justify-end gap-1">
                  <p className="text-xs text-zinc-400">
                    {earningsData.eligibility.isEligible
                      ? "Ready"
                      : earningsData.eligibility.readyAmount > 0
                        ? `${formatCurrency(earningsData.eligibility.readyAmount)} / ${formatCurrency(earningsData.eligibility.minimumAmount)}`
                        : "No ready earnings yet"}
                  </p>
                  {!earningsData.eligibility.isEligible && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 text-zinc-400 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Minimum payout threshold. Your ready balance must reach this amount before a payout can be initiated.</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between py-3 last:pb-0">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-violet-50 flex items-center justify-center">
                <CheckCircle2 className="h-4 w-4 text-violet-600" />
              </div>
              <span className="text-sm text-zinc-600">Completed This Month</span>
            </div>
            <span className="text-lg font-semibold text-zinc-900">
              {completedThisMonth}
            </span>
          </div>
        </div>
      </TooltipProvider>
    </DataCard>
  );
}

export function HomeTab({
  appointments,
  consultantId,
  consultantName,
  pendingRequestsCount = 0,
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const client = useStreamVideoClient();
  const { toast } = useToast();

  const handleJoinMeeting = async (
    appointment: TAppointment,
    joinableSlot?: TAppointment["slotsOfAppointment"][number],
  ) => {
    if (!client) {
      toast({ title: "Error", description: "Meeting client not ready." });
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

  const expandedAppointments = appointments || [];

  const todayRemainingAppointments = useMemo(
    () =>
      getTodayAppointments(expandedAppointments).filter(
        (appointment) => getAppointmentStatus(appointment) !== "Completed",
      ),
    [expandedAppointments],
  );

  // Limit display to 6 items, but keep the full count for stats
  const todayAppointments = useMemo(
    () => todayRemainingAppointments.slice(0, 6),
    [todayRemainingAppointments],
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

  // Calculate stats from real data
  const totalToday = useMemo(
    () => getTodayAppointments(expandedAppointments).length,
    [expandedAppointments],
  );
  const totalUpcoming = allUpcomingAppointments.length;

  // Calculate completed this month
  const completedThisMonth = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    return expandedAppointments.filter((appointment) => {
      const status = getAppointmentStatus(appointment);
      if (status !== "Completed") return false;

      const startTime = getStartTime(appointment);
      if (!startTime) return false;

      return startTime >= startOfMonth && startTime <= now;
    }).length;
  }, [expandedAppointments]);

  const totalCompleted = useMemo(
    () =>
      expandedAppointments.filter(
        (apt) => getAppointmentStatus(apt) === "Completed",
      ).length,
    [expandedAppointments],
  );

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
          {/* Stats Grid */}
          <motion.div variants={fadeInUp}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Today's Sessions"
                value={totalToday}
                subtitle={`${todayRemainingAppointments.length} remaining`}
                icon={Calendar}
                variant="info"
              />
              <StatCard
                title="Upcoming"
                value={totalUpcoming}
                subtitle="All scheduled"
                icon={Clock}
                variant="default"
              />
              <StatCard
                title="Pending Requests"
                value={pendingRequestsCount}
                subtitle="Awaiting response"
                icon={Bell}
                variant="warning"
                onClick={() =>
                  router.push(`/dashboard/consultant/${consultantId}/requests`)
                }
              />
              <StatCard
                title="Completed"
                value={totalCompleted}
                subtitle={`${completedThisMonth} this month`}
                icon={TrendingUp}
                variant="success"
              />
            </div>
          </motion.div>

          {/* Main Content Grid - Appointments + Quick Stats */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Today's + Upcoming */}
            <motion.div variants={fadeInUp} className="lg:col-span-2 space-y-6">
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
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-zinc-900 truncate text-sm">
                                {userName}
                              </h3>
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
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-zinc-900 truncate">
                                {userName}
                              </h4>
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

            {/* Right Column - Quick Stats & Pending Requests */}
            <motion.div variants={fadeInUp} className="space-y-6">
              <QuickStatsPanel
                appointments={expandedAppointments}
                consultantId={consultantId}
              />

              {/* Pending Requests */}
              <DataCard
                title="Pending Requests"
                icon={FileText}
                viewAllLink={`/dashboard/consultant/${consultantId}/requests`}
                viewAllText="View all requests"
              >
                <div className="max-h-[300px] overflow-y-auto -mx-5 px-5">
                  <RequestSlotAllocationTabMini />
                </div>
              </DataCard>
            </motion.div>
          </div>
        </motion.div>
      </DashboardContent>
    </>
  );
}
