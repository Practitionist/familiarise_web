"use client";

import { useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import {
  DataCard,
  ActivityItem,
  EmptyState,
} from "@/components/dashboard/DataCard";
import { AppointmentCard } from "@/components/dashboard/AppointmentCard";
import {
  Calendar,
  Clock,
  Users,
  Video,
  TrendingUp,
  ChevronRight,
  FileText,
  Bell,
} from "lucide-react";
import {
  calculateSessionProgress,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeImage,
  getConsumeeName,
  getGroupStatus,
  getGroupTitle,
  getStartTime,
  getSlotTimes,
  getTodayAppointments,
  getUpcomingAppointments,
  groupRecurringAppointments,
  sortAppointmentsByStartTime,
} from "../../utils/appointmentHelpers";

import { IActivity, IApproval, BADGE_STYLES, getBadgeStyle } from "../../types";
import { TAppointment } from "@/types/appointment";
import { RequestSlotAllocationTabMini } from "../requests/RequestSlotAllocationTabMini";

type BadgeStyleMap = typeof BADGE_STYLES;

interface HomeTabProps {
  appointments: TAppointment[];
  activities: IActivity[];
  approvals: IApproval[];
  badgeStyles: BadgeStyleMap;
  consultantId: string;
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
  activities,
  badgeStyles,
  consultantId,
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const client = useStreamVideoClient();
  const { toast } = useToast();

  const handleJoinMeeting = async (appointment: TAppointment) => {
    if (!client) {
      toast({ title: "Error", description: "Meeting client not ready." });
      return;
    }
    const relevantSlot = appointment.slotsOfAppointment?.[0];
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
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to join meeting.",
        variant: "destructive",
      });
    }
  };

  // Process appointments - memoize expensive computations
  const expandedAppointments = useMemo(
    () =>
      (appointments || []).flatMap((appointment) => {
        if (
          !appointment.slotsOfAppointment ||
          appointment.slotsOfAppointment.length === 0
        ) {
          return [appointment];
        }
        return appointment.slotsOfAppointment.map((slot) => ({
          ...appointment,
          id: `${appointment.id}-${slot.id}`,
          slotsOfAppointment: [slot],
        }));
      }),
    [appointments],
  );

  const todayAppointments = useMemo(
    () =>
      getTodayAppointments(expandedAppointments)
        .filter(
          (appointment) => getAppointmentStatus(appointment) !== "Completed",
        )
        .slice(0, 4),
    [expandedAppointments],
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
    return Object.entries(groupedAll).slice(0, 5);
  }, [allUpcomingAppointments]);

  // Calculate stats from real data
  const totalToday = useMemo(
    () => getTodayAppointments(expandedAppointments).length,
    [expandedAppointments],
  );
  const totalUpcoming = allUpcomingAppointments.length;

  // Calculate pending requests and completed this week with memoization
  const { pendingRequests, completedThisWeek } = useMemo(() => {
    // Calculate pending requests from appointments with PENDING status
    const pending = (appointments || []).filter((appointment) => {
      const consultation = appointment.consultation;
      const subscription = appointment.subscription;
      const status =
        consultation?.requestStatus ?? subscription?.requestStatus ?? null;
      return status === "PENDING" || status === "APPROVED_PENDING_PAYMENT";
    }).length;

    // Calculate completed this week
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Go to Sunday
    startOfWeek.setHours(0, 0, 0, 0);

    const completed = expandedAppointments.filter((appointment) => {
      const status = getAppointmentStatus(appointment);
      if (status !== "Completed") return false;

      const startTime = getStartTime(appointment);
      if (!startTime) return false;

      return startTime >= startOfWeek && startTime <= now;
    }).length;

    return { pendingRequests: pending, completedThisWeek: completed };
  }, [appointments, expandedAppointments]);

  return (
    <>
      <DashboardHeader
        title="Welcome back"
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
            <DashboardGrid columns={4}>
              <StatCard
                title="Today's Sessions"
                value={totalToday}
                subtitle={`${todayAppointments.length} remaining`}
                icon={Calendar}
                variant="info"
              />
              <StatCard
                title="Upcoming"
                value={totalUpcoming}
                subtitle="Next 30 days"
                icon={Clock}
                variant="default"
              />
              <StatCard
                title="Pending Requests"
                value={pendingRequests}
                subtitle="Awaiting response"
                icon={Bell}
                variant="warning"
                onClick={() =>
                  router.push(`/dashboard/consultant/${consultantId}/requests`)
                }
              />
              <StatCard
                title="This Week"
                value={completedThisWeek}
                subtitle="Sessions completed"
                icon={TrendingUp}
                trend={{ value: 12, isPositive: true }}
                variant="success"
              />
            </DashboardGrid>
          </motion.div>

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Appointments */}
            <motion.div variants={fadeInUp} className="lg:col-span-2 space-y-6">
              {/* Today's Appointments */}
              <DataCard
                title="Today's Appointments"
                icon={Calendar}
                viewAllLink={`/dashboard/consultant/${consultantId}/appointments`}
              >
                {todayAppointments.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {todayAppointments.map((appointment) => {
                      const userName = getConsumeeName(appointment);
                      const status = getAppointmentStatus(appointment);
                      const startTime = getStartTime(appointment);
                      const isJoinable = status === "Meeting in 5 min";

                      return (
                        <motion.div
                          key={appointment.id}
                          whileHover={{ scale: 1.01 }}
                          className="group relative overflow-hidden rounded-xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-4 transition-all hover:shadow-md"
                        >
                          <div className="flex items-start gap-3">
                            <Avatar className="h-11 w-11 ring-2 ring-white shadow-sm">
                              <AvatarImage
                                alt={userName}
                                src={getConsumeeImage(appointment)}
                              />
                              <AvatarFallback className="bg-zinc-100 text-zinc-600 font-medium">
                                {userName
                                  .split(" ")
                                  .map((n: string) => n[0])
                                  .join("")}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-semibold text-zinc-900 truncate">
                                {userName}
                              </h3>
                              <p className="text-sm text-zinc-500 truncate">
                                {getAppointmentTypeAndPlan(appointment)}
                              </p>
                            </div>
                          </div>

                          <div className="mt-4 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm text-zinc-500">
                              <Clock className="h-4 w-4" />
                              <span>
                                {startTime
                                  ? formatAppointmentTime(
                                      startTime.toISOString(),
                                    )
                                  : "TBD"}
                              </span>
                            </div>
                            <Badge className={getBadgeStyle(status)}>
                              {status}
                            </Badge>
                          </div>

                          {isJoinable && (
                            <Button
                              onClick={() => handleJoinMeeting(appointment)}
                              className="mt-4 w-full bg-zinc-900 hover:bg-zinc-800 text-white gap-2"
                              size="sm"
                            >
                              <Video className="h-4 w-4" />
                              Join Meeting
                            </Button>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    icon={Calendar}
                    title="No appointments today"
                    description="Enjoy your free time or check upcoming sessions"
                  />
                )}
              </DataCard>

              {/* Upcoming Appointments */}
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
                      const startTime = getStartTime(firstAppointment);

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
                              {userName
                                .split(" ")
                                .map((n: string) => n[0])
                                .join("")}
                            </AvatarFallback>
                          </Avatar>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-zinc-900 truncate">
                                {userName}
                              </h4>
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
                  />
                )}
              </DataCard>
            </motion.div>

            {/* Right Column - Activity & Approvals */}
            <motion.div variants={fadeInUp} className="space-y-6">
              {/* Client Activity */}
              <DataCard title="Recent Activity" icon={Users}>
                {activities.length > 0 ? (
                  <div className="divide-y divide-zinc-100">
                    {activities.slice(0, 5).map((activity) => (
                      <ActivityItem
                        key={activity.id}
                        name={activity.actorName}
                        action={activity.description}
                        time={activity.timeAgo}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={Users}
                    title="No recent activity"
                    description="Client activity will appear here"
                  />
                )}
              </DataCard>

              {/* Pending Approvals */}
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
