"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  Calendar,
  ChevronRight,
  ChevronLeft,
  Video,
  Users,
  Loader2,
  CheckCircle2,
  Clock,
  BookOpen,
  Building2,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import { PendingPaymentsWidget } from "./PendingPaymentsWidget";
import { format, differenceInHours, differenceInDays } from "date-fns";
import { useState, useMemo, useRef } from "react";
// #248: do NOT statically import the Stream SDK (useStreamVideoClient) or
// lib/meeting (which imports the SDK) here — that would pull the heavy SDK into
// the dashboard-HOME bundle / critical path. The video client + meeting helper
// are acquired lazily inside the Join handler (only when a user clicks Join).
import { getGlobalVideoClient } from "@/lib/stream/disconnect";
import { useToast } from "@/hooks/use-toast";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";
import {
  type ProcessedEvent,
  processAllEvents,
  getUpcomingEvents,
  getMonthlyEvents,
  groupSlotsIntoSessions,
} from "./event-processor";
import { WaitlistStatusBadge } from "@/components/ui/waitlist-status-badge";
import { getStatusStyle } from "../../utils/statusConfig";
import { DEFAULT_MEETING_DURATION_MS } from "../appointments/types";

interface HomeTabProps {
  userDetails: {
    id: string;
    name: string;
    email: string;
    image?: string;
  };
  eventsData: TConsulteeEventsResponse;
  isRefreshing?: boolean;
  consulteeId: string;
}

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const JOIN_WINDOW_BEFORE_START_MS = 10 * 60 * 1000; // 10 minutes

const fadeInUp = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

// Get time away text
function getTimeAway(date: Date): { text: string; urgent: boolean } {
  const now = new Date();
  const hoursAway = differenceInHours(date, now);
  const daysAway = differenceInDays(date, now);

  if (hoursAway < 0) return { text: "Past", urgent: false };
  if (hoursAway < 1) return { text: "Starting soon", urgent: true };
  if (hoursAway < 24) {
    const mins = Math.floor((hoursAway % 1) * 60);
    return {
      text: `${Math.floor(hoursAway)}h ${mins > 0 ? `${mins}m` : ""} away`,
      urgent: hoursAway < 2,
    };
  }
  if (daysAway === 1) return { text: "1 day away", urgent: false };
  return { text: `${daysAway} days away`, urgent: false };
}

// Session Card for horizontal scroll - Modern dark theme with FIXED heights for consistency
function UpcomingSessionCard({
  event,
  onClick,
  onJoin,
  isJoining,
}: {
  event: ProcessedEvent;
  onClick?: () => void;
  onJoin?: () => void;
  isJoining?: boolean;
}) {
  const timeAway = getTimeAway(event.startsAt);
  const { data: session } = useSession();
  const sponsoringOrgName = event.organizationId
    ? (session?.user?.organizationMemberships?.find(
        (m) => m.organizationId === event.organizationId,
      )?.organizationName ?? "your organization")
    : null;

  // Match Appointments tab guards (OneOffEventCard.tsx:96-103)
  const statusUpper = event.status?.toUpperCase();
  const isInactive =
    statusUpper === "CANCELLED" ||
    statusUpper === "REJECTED" ||
    statusUpper === "COMPLETED" ||
    statusUpper === "EXPIRED";
  const isApproved = (() => {
    if (event.type === "webinar" || event.type === "class") {
      return event.bookingStatus === "CONFIRMED";
    }
    return statusUpper === "APPROVED";
  })();
  const isTentative = event.joinableSlot?.isTentative ?? true;
  const canShowJoin = !isTentative && isApproved && !isInactive;

  // Time-window gate (matching JoinButton.tsx:getJoinState)
  const isWithinJoinWindow = (() => {
    if (!event.joinableSlot) return false;
    const now = Date.now();
    const start = new Date(event.joinableSlot.startsAt).getTime();
    const end = event.joinableSlot.endsAt
      ? new Date(event.joinableSlot.endsAt).getTime()
      : start + DEFAULT_MEETING_DURATION_MS;
    const joinWindow = start - JOIN_WINDOW_BEFORE_START_MS;
    return now >= joinWindow && now <= end;
  })();

  // Type badges - outline/border style only, no background colors
  const typeLabels: Record<string, string> = {
    consultation: "CONSULTATION",
    subscription: "SUBSCRIPTION",
    class: "CLASS",
    webinar: "WEBINAR",
  };

  const typeLabel = typeLabels[event.type] || "EVENT";
  const statusStyle = getStatusStyle(event.status, "dark");

  return (
    <motion.div
      whileHover={{ y: -2 }}
      onClick={onClick}
      className="flex-shrink-0 w-[340px] h-[180px] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 rounded-xl border border-zinc-800 p-4 hover:border-zinc-700 transition-all duration-200 shadow-lg flex flex-col"
    >
      {/* Row 1: Avatar + Title/Name + Time Badge - Fixed height 48px */}
      <div className="flex items-center gap-3 h-12 shrink-0">
        <div className="flex items-center -space-x-1.5 shrink-0">
          <Avatar className="h-10 w-10 ring-2 ring-zinc-800 z-10">
            <AvatarImage
              src={event.consultantImage ?? undefined}
              alt={event.consultantName}
            />
            <AvatarFallback className="bg-zinc-700 text-zinc-300 text-xs font-semibold">
              {event.consultantName
                .split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          {event.collaborators?.slice(0, 1).map((collab, idx) => (
            <Avatar
              key={idx}
              className="h-7 w-7 ring-2 ring-zinc-800 z-0"
              title={collab.name}
            >
              <AvatarImage src={collab.image ?? undefined} alt={collab.name} />
              <AvatarFallback className="bg-zinc-700 text-zinc-300 text-[9px] font-semibold">
                {collab.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
          ))}
          {(event.collaborators?.length ?? 0) > 1 && (
            <div className="h-7 w-7 rounded-full bg-zinc-700 ring-2 ring-zinc-800 flex items-center justify-center text-[9px] font-semibold text-zinc-300 z-0">
              +{(event.collaborators?.length ?? 0) - 1}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <h4 className="font-semibold text-white text-sm leading-tight truncate">
            {event.title}
          </h4>
          <p className="text-xs text-zinc-400 truncate">
            {event.collaborators && event.collaborators.length > 0
              ? event.collaborators.length === 1
                ? `${event.consultantName} & ${event.collaborators[0].name}`
                : `${event.consultantName} + ${event.collaborators.length} others`
              : event.consultantName}
          </p>
        </div>
        <Badge
          className={cn(
            "shrink-0 text-[10px] font-medium px-2 py-0.5 border-0 whitespace-nowrap",
            timeAway.urgent
              ? "bg-rose-500/20 text-rose-400"
              : "bg-zinc-700 text-zinc-300",
          )}
        >
          {timeAway.text}
        </Badge>
      </div>

      {/* Row 2: Date and time - Fixed height with top margin */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 mt-3 h-5 shrink-0 overflow-hidden">
        <Calendar className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {format(event.startsAt, "EEE, d MMM yyyy")}
        </span>
        <span className="text-zinc-600 shrink-0">•</span>
        <span className="shrink-0">{format(event.startsAt, "h:mm a")}</span>
      </div>

      {/* Row 2.5: Sponsor pill — only when org-funded. Placed on its own
          line so Row 3 stays uncrowded (CONSULTATION + APPROVED + Join). */}
      {sponsoringOrgName && (
        <div className="flex items-center mt-1.5 h-5 shrink-0">
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 bg-zinc-700 text-zinc-300 rounded-md max-w-full"
            title={`Sponsored by ${sponsoringOrgName}`}
          >
            <Building2 className="h-3 w-3 shrink-0" />
            <span className="truncate">Sponsored · {sponsoringOrgName}</span>
          </span>
        </div>
      )}

      {/* Spacer to push footer to bottom */}
      <div className="flex-1" />

      {/* Row 3: Badges and action - Fixed at bottom */}
      <div className="flex items-center justify-between gap-2 h-8 shrink-0">
        <div className="flex items-center gap-1.5 overflow-hidden">
          <Badge className="text-[10px] font-medium px-2 py-0.5 bg-transparent border border-zinc-600 text-zinc-300 shrink-0 rounded-md">
            {typeLabel}
          </Badge>
          {/* Show booking status badge for webinars and classes */}
          {(event.type === "webinar" || event.type === "class") &&
            event.bookingStatus && (
              <WaitlistStatusBadge
                bookingStatus={event.bookingStatus}
                waitlistPosition={event.waitlistPosition}
                size="sm"
                showIcon={false}
                className="shrink-0 border-0"
              />
            )}
          {/* Only show event status if not showing booking status */}
          {!(
            (event.type === "webinar" || event.type === "class") &&
            event.bookingStatus
          ) && (
            <Badge
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 border-0 shrink-0",
                statusStyle.bg,
                statusStyle.text,
              )}
            >
              {event.status.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
        {canShowJoin && (
          <Button
            size="sm"
            className="h-7 px-3 text-xs bg-white hover:bg-zinc-100 text-zinc-900 font-semibold rounded-md shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onJoin?.();
            }}
            disabled={
              isJoining || !isWithinJoinWindow || !event.joinableAppointment
            }
          >
            {isJoining ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Video className="h-3 w-3 mr-1" />
            )}
            {isJoining ? "Joining..." : "Join"}
          </Button>
        )}
      </div>
    </motion.div>
  );
}

// Monthly event item - Elegant minimal design
function MonthlyEventItem({
  event,
  isExpanded,
  onToggle,
}: {
  event: ProcessedEvent;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { data: session } = useSession();
  const sponsoringOrgName = event.organizationId
    ? (session?.user?.organizationMemberships?.find(
        (m) => m.organizationId === event.organizationId,
      )?.organizationName ?? "your organization")
    : null;

  // Type labels - border style
  const typeLabels: Record<string, string> = {
    consultation: "Consultation",
    subscription: "Subscription",
    class: "Class",
    webinar: "Webinar",
  };

  const typeLabel = typeLabels[event.type] || "Event";
  const statusStyle = getStatusStyle(event.status, "light");

  return (
    <div className="border-b border-border last:border-0">
      <div
        onClick={onToggle}
        className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center -space-x-1.5 flex-shrink-0">
          <Avatar className="h-10 w-10 ring-2 ring-card z-10">
            <AvatarImage
              src={event.consultantImage ?? undefined}
              alt={event.consultantName}
            />
            <AvatarFallback className="bg-muted text-muted-foreground text-xs font-medium">
              {event.consultantName
                .split(" ")
                .map((n) => n[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          {event.collaborators?.slice(0, 1).map((collab, idx) => (
            <Avatar
              key={idx}
              className="h-7 w-7 ring-2 ring-card z-0"
              title={collab.name}
            >
              <AvatarImage src={collab.image ?? undefined} alt={collab.name} />
              <AvatarFallback className="bg-muted text-muted-foreground text-[9px] font-medium">
                {collab.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
          ))}
          {(event.collaborators?.length ?? 0) > 1 && (
            <div className="h-7 w-7 rounded-full bg-muted ring-2 ring-card flex items-center justify-center text-[9px] font-medium text-muted-foreground z-0">
              +{(event.collaborators?.length ?? 0) - 1}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          {/* Desktop: single row layout */}
          <div className="hidden lg:flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h4 className="font-medium text-foreground text-sm truncate">
                {event.title}
              </h4>
              <p className="text-xs text-muted-foreground truncate">
                {event.collaborators && event.collaborators.length > 0
                  ? event.collaborators.length === 1
                    ? `${event.consultantName} & ${event.collaborators[0].name}`
                    : `${event.consultantName} + ${event.collaborators.length} others`
                  : event.consultantName}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {sponsoringOrgName && (
                <Badge
                  className="text-[10px] font-semibold px-2 py-0.5 bg-muted text-muted-foreground border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                  title={`Sponsored by ${sponsoringOrgName}`}
                >
                  <Building2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    Sponsored · {sponsoringOrgName}
                  </span>
                </Badge>
              )}
              <Badge className="text-[10px] font-medium bg-transparent border border-border text-muted-foreground rounded-md">
                {typeLabel}
              </Badge>
              {/* Show booking status badge for webinars and classes */}
              {(event.type === "webinar" || event.type === "class") &&
                event.bookingStatus && (
                  <WaitlistStatusBadge
                    bookingStatus={event.bookingStatus}
                    waitlistPosition={event.waitlistPosition}
                    size="sm"
                    showIcon={false}
                  />
                )}
              {/* Only show event status if not showing booking status */}
              {!(
                (event.type === "webinar" || event.type === "class") &&
                event.bookingStatus
              ) && (
                <Badge
                  className={cn(
                    "text-[10px] font-medium border-0",
                    statusStyle.bg,
                    statusStyle.text,
                  )}
                >
                  {event.status.replace(/_/g, " ")}
                </Badge>
              )}
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-muted-foreground/70 transition-transform duration-200",
                  isExpanded && "rotate-90",
                )}
              />
            </div>
          </div>
          {/* Mobile: stacked layout */}
          <div className="lg:hidden">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="min-w-0 flex-1">
                <h4 className="font-medium text-foreground text-sm truncate">
                  {event.title}
                </h4>
                <p className="text-xs text-muted-foreground truncate">
                  {event.collaborators && event.collaborators.length > 0
                    ? event.collaborators.length === 1
                      ? `${event.consultantName} & ${event.collaborators[0].name}`
                      : `${event.consultantName} + ${event.collaborators.length} others`
                    : event.consultantName}
                </p>
              </div>
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-muted-foreground/70 transition-transform duration-200 flex-shrink-0 mt-0.5",
                  isExpanded && "rotate-90",
                )}
              />
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {sponsoringOrgName && (
                <Badge
                  className="text-[10px] font-semibold px-2 py-0.5 bg-muted text-muted-foreground border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                  title={`Sponsored by ${sponsoringOrgName}`}
                >
                  <Building2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    Sponsored · {sponsoringOrgName}
                  </span>
                </Badge>
              )}
              <Badge className="text-[10px] font-medium bg-transparent border border-border text-muted-foreground rounded-md">
                {typeLabel}
              </Badge>
              {/* Show booking status badge for webinars and classes (mobile) */}
              {(event.type === "webinar" || event.type === "class") &&
                event.bookingStatus && (
                  <WaitlistStatusBadge
                    bookingStatus={event.bookingStatus}
                    waitlistPosition={event.waitlistPosition}
                    size="sm"
                    showIcon={false}
                  />
                )}
              {/* Only show event status if not showing booking status (mobile) */}
              {!(
                (event.type === "webinar" || event.type === "class") &&
                event.bookingStatus
              ) && (
                <Badge
                  className={cn(
                    "text-[10px] font-medium border-0",
                    statusStyle.bg,
                    statusStyle.text,
                  )}
                >
                  {event.status.replace(/_/g, " ")}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Expanded sessions (slots grouped by appointment) */}
      {isExpanded && event.slots.length > 0 && (() => {
        const sessions = groupSlotsIntoSessions(event.slots);
        return (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="pl-16 pr-4 pb-4"
          >
            <div className="space-y-2 bg-muted rounded-lg p-3">
              {sessions.slice(0, 10).map((session) => (
                <div
                  key={session.appointmentId}
                  className="flex items-center gap-4 text-sm text-muted-foreground"
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full flex-shrink-0",
                      session.status === "completed"
                        ? "bg-muted-foreground/30"
                        : "bg-emerald-500 dark:bg-emerald-400",
                    )}
                  />
                  <span className="w-24 font-medium text-foreground">
                    {format(session.startTime, "EEE d MMM")}
                  </span>
                  <span className="text-muted-foreground">
                    {format(session.startTime, "h:mm a")} -{" "}
                    {format(session.endTime, "h:mm a")}
                  </span>
                  <span
                    className={cn(
                      "text-xs ml-auto capitalize",
                      session.status === "completed"
                        ? "text-muted-foreground/70"
                        : "text-emerald-600 dark:text-emerald-300",
                    )}
                  >
                    {session.status}
                  </span>
                </div>
              ))}
              {sessions.length > 10 && (
                <p className="text-xs text-muted-foreground/70 pt-1">
                  +{sessions.length - 10} more sessions
                </p>
              )}
            </div>
          </motion.div>
        );
      })()}
    </div>
  );
}

// Learning Stats Panel — derives all stats from processed events
function LearningStatsPanel({ events }: { events: ProcessedEvent[] }) {
  const stats = useMemo(() => {
    const now = new Date();
    const inactive = ["cancelled", "rejected", "expired"];
    let completedSessions = 0;
    let hoursLearned = 0;
    const activePrograms = new Set<string>();
    const experts = new Set<string>();

    for (const event of events) {
      if (inactive.includes(event.status.toLowerCase())) continue;

      experts.add(event.consultantName);

      // Count grouped sessions (not raw slots) for "Sessions Completed"
      const sessions = groupSlotsIntoSessions(event.slots);
      completedSessions += sessions.filter(
        (s) => s.status === "completed",
      ).length;

      // Hours still computed per-slot (correct granularity for duration)
      let hasUpcoming = false;
      for (const slot of event.slots) {
        if (slot.endsAt < now) {
          hoursLearned +=
            (slot.endsAt.getTime() - slot.startsAt.getTime()) / 3_600_000;
        }
        if (slot.startsAt > now) hasUpcoming = true;
      }
      if (hasUpcoming) activePrograms.add(event.id);
    }

    return {
      completedSessions,
      hoursLearned: Math.round(hoursLearned * 10) / 10,
      activePrograms: activePrograms.size,
      experts: experts.size,
    };
  }, [events]);

  const rows = [
    {
      icon: CheckCircle2,
      label: "Sessions Completed",
      value: stats.completedSessions,
      color:
        "text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-900/30",
    },
    {
      icon: Clock,
      label: "Hours Learned",
      value: stats.hoursLearned,
      color: "text-foreground bg-muted",
    },
    {
      icon: BookOpen,
      label: "Active Programs",
      value: stats.activePrograms,
      color: "text-foreground bg-muted",
    },
    {
      icon: Users,
      label: "Experts Consulted",
      value: stats.experts,
      color:
        "text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-900/30",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {rows.map((row) => (
        <div
          key={row.label}
          className="bg-card rounded-xl border border-border shadow-sm p-4 flex flex-col gap-3"
        >
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                "h-9 w-9 rounded-lg flex items-center justify-center shrink-0",
                row.color,
              )}
            >
              <row.icon className="h-4.5 w-4.5" />
            </div>
            <span className="text-sm text-muted-foreground font-medium">
              {row.label}
            </span>
          </div>
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {row.label === "Hours Learned" ? `${row.value}h` : row.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export default function HomeTab({
  userDetails,
  eventsData,
  isRefreshing = false,
  consulteeId,
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);
  const { toast } = useToast();

  // Handle joining a meeting
  const handleJoinMeeting = async (event: ProcessedEvent) => {
    if (!event.joinableAppointment || !event.joinableSlot) {
      toast({
        title: "Unable to join",
        description: "Meeting data is not available.",
        variant: "destructive",
      });
      return;
    }

    // #248: read the already-connected video client singleton at click time
    // (same instance <StreamVideo> uses) instead of via useStreamVideoClient,
    // so the SDK stays off the home bundle.
    const client = getGlobalVideoClient();
    if (!client) {
      toast({
        title: "Not signed in",
        description: "Video client not initialized. Please sign in to join.",
        variant: "warning",
      });
      return;
    }

    setJoiningEventId(event.id);
    try {
      // #248: lazy-import the meeting helper (it imports the SDK) on demand.
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        event.joinableAppointment,
        event.joinableSlot,
      );
      router.push(`/meetings/${meetingId}`);
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting",
        variant: "success",
      });
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setJoiningEventId(null);
    }
  };

  // Process events into unified format using the utility function
  const processedEvents = useMemo(
    () => processAllEvents(eventsData),
    [eventsData],
  );

  // Get upcoming events
  const upcomingEvents = useMemo(
    () => getUpcomingEvents(processedEvents),
    [processedEvents],
  );

  // Get events for current month
  const monthlyEvents = useMemo(
    () => getMonthlyEvents(processedEvents, currentMonth),
    [processedEvents, currentMonth],
  );

  // Scroll handlers
  const scrollLeft = () => {
    scrollContainerRef.current?.scrollBy({ left: -300, behavior: "smooth" });
  };

  const scrollRight = () => {
    scrollContainerRef.current?.scrollBy({ left: 300, behavior: "smooth" });
  };

  const toggleExpanded = (id: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <motion.div
      variants={staggerChildren}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Refreshing indicator */}
      {isRefreshing && (
        <div className="fixed top-20 right-4 bg-foreground text-background px-4 py-2 rounded-lg text-sm z-50 shadow-lg flex items-center gap-2">
          <div className="h-3 w-3 border-2 border-background/30 border-t-background rounded-full animate-spin" />
          Refreshing...
        </div>
      )}

      {/* Welcome + Learning Stats */}
      <motion.div variants={fadeInUp} className="space-y-5">
        <div>
          <h1 className="text-fluid-2xl font-semibold tracking-tight text-foreground">
            Welcome back, {userDetails.name?.split(" ")[0]}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Here&apos;s an overview of your learning journey
          </p>
        </div>
        <LearningStatsPanel events={processedEvents} />
      </motion.div>

      {/* Upcoming Sessions - Dark cards with horizontal scroll */}
      <motion.div variants={fadeInUp}>
        <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 className="font-semibold text-foreground text-lg">
              Upcoming Sessions
            </h2>
            {upcomingEvents.length > 3 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={scrollLeft}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={scrollRight}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          <div className="p-5 bg-gradient-to-b from-muted/50 to-card">
            {upcomingEvents.length > 0 ? (
              <div
                ref={scrollContainerRef}
                className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide"
                style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
              >
                {upcomingEvents.map((event) => (
                  <UpcomingSessionCard
                    key={event.id}
                    event={event}
                    onJoin={() => handleJoinMeeting(event)}
                    isJoining={joiningEventId === event.id}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-16">
                <div className="mx-auto h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <Calendar className="h-8 w-8 text-muted-foreground/70" />
                </div>
                <h4 className="font-semibold text-foreground text-lg">
                  No upcoming sessions
                </h4>
                <p className="text-sm text-muted-foreground mt-1 mb-5">
                  Book a session with an expert to get started
                </p>
                <Button onClick={() => router.push("/explore/experts")}>
                  <Users className="h-4 w-4 mr-2" />
                  Find Experts
                </Button>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* Main content grid */}
      <motion.div
        variants={fadeInUp}
        className="grid grid-cols-1 lg:grid-cols-3 gap-6"
      >
        {/* Monthly Schedule */}
        <div className="lg:col-span-2">
          <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="font-semibold text-foreground text-lg">
                {format(currentMonth, "MMMM yyyy")}
              </h2>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() =>
                    setCurrentMonth(
                      new Date(
                        currentMonth.getFullYear(),
                        currentMonth.getMonth() - 1,
                        1,
                      ),
                    )
                  }
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() =>
                    setCurrentMonth(
                      new Date(
                        currentMonth.getFullYear(),
                        currentMonth.getMonth() + 1,
                        1,
                      ),
                    )
                  }
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="max-h-[400px] overflow-y-auto">
              {monthlyEvents.length > 0 ? (
                monthlyEvents.map((event) => (
                  <MonthlyEventItem
                    key={event.id}
                    event={event}
                    isExpanded={expandedEvents.has(event.id)}
                    onToggle={() => toggleExpanded(event.id)}
                  />
                ))
              ) : (
                <div className="text-center py-16">
                  <Calendar className="h-10 w-10 text-muted-foreground/70 mx-auto mb-3" />
                  <p className="text-muted-foreground">
                    No sessions scheduled for this month
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right sidebar — stretch to match monthly schedule */}
        <div className="lg:h-full">
          <PendingPaymentsWidget consulteeId={consulteeId} />
        </div>
      </motion.div>
    </motion.div>
  );
}
