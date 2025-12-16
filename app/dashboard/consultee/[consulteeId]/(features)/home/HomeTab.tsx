"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  Calendar,
  Clock,
  ChevronRight,
  ChevronLeft,
  Video,
  Users,
  Sparkles,
  Check,
  Crown,
  Zap,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import { PendingPaymentsWidget } from "./PendingPaymentsWidget";
import {
  format,
  isSameMonth,
  differenceInHours,
  differenceInDays,
} from "date-fns";
import { useState, useMemo, useRef } from "react";

interface HomeTabProps {
  userDetails: {
    id: string;
    name: string;
    email: string;
    image?: string;
  };
  eventsData: {
    consultations: any[];
    subscriptions: any[];
    classes: any[];
    webinars: any[];
  };
  isRefreshing?: boolean;
  consulteeId: string;
}

interface ProcessedEvent {
  id: string;
  type: "consultation" | "subscription" | "class" | "webinar";
  title: string;
  consultantName: string;
  consultantImage?: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  slots: Array<{ startsAt: Date; endsAt: Date }>;
  appointmentId?: string;
}

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

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
    return { text: `${Math.floor(hoursAway)}h ${mins > 0 ? `${mins}m` : ""} away`, urgent: hoursAway < 2 };
  }
  if (daysAway === 1) return { text: "1 day away", urgent: false };
  return { text: `${daysAway} days away`, urgent: false };
}

// Session Card for horizontal scroll - Modern dark theme with FIXED heights for consistency
function UpcomingSessionCard({
  event,
  onClick,
}: {
  event: ProcessedEvent;
  onClick?: () => void;
}) {
  const timeAway = getTimeAway(event.startsAt);

  // Type badges - outline/border style only, no background colors
  const typeLabels: Record<string, string> = {
    consultation: "CONSULTATION",
    subscription: "SUBSCRIPTION",
    class: "CLASS",
    webinar: "WEBINAR",
  };

  // Status badges - refined professional colors
  const statusConfig: Record<string, { bg: string; text: string }> = {
    APPROVED: { bg: "bg-teal-500/15", text: "text-teal-400" },            // Teal - sophisticated success
    PENDING: { bg: "bg-orange-500/15", text: "text-orange-400" },         // Orange - warm urgency
    SCHEDULED: { bg: "bg-indigo-500/15", text: "text-indigo-400" },       // Indigo - elegant upcoming
    IN_PROGRESS: { bg: "bg-cyan-500/15", text: "text-cyan-400" },         // Cyan - bright active
    COMPLETED: { bg: "bg-slate-500/15", text: "text-slate-400" },         // Slate - warm done
    CANCELLED: { bg: "bg-stone-500/15", text: "text-stone-400" },         // Stone - neutral inactive
    REJECTED: { bg: "bg-red-500/15", text: "text-red-400" },              // Red - clear negative
  };

  const typeLabel = typeLabels[event.type] || "EVENT";
  const statusStyle = statusConfig[event.status] || statusConfig.PENDING;

  return (
    <motion.div
      whileHover={{ y: -2 }}
      onClick={onClick}
      className="flex-shrink-0 w-[340px] h-[180px] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 rounded-xl border border-zinc-800 p-4 cursor-pointer hover:border-zinc-700 transition-all duration-200 shadow-lg flex flex-col"
    >
      {/* Row 1: Avatar + Title/Name + Time Badge - Fixed height 48px */}
      <div className="flex items-center gap-3 h-12 shrink-0">
        <Avatar className="h-10 w-10 ring-2 ring-zinc-700 shrink-0">
          <AvatarImage src={event.consultantImage} alt={event.consultantName} />
          <AvatarFallback className="bg-zinc-700 text-zinc-300 text-xs font-semibold">
            {event.consultantName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0 overflow-hidden">
          <h4 className="font-semibold text-white text-sm leading-tight truncate">
            {event.title}
          </h4>
          <p className="text-xs text-zinc-400 truncate">{event.consultantName}</p>
        </div>
        <Badge
          className={cn(
            "shrink-0 text-[10px] font-medium px-2 py-0.5 border-0 whitespace-nowrap",
            timeAway.urgent
              ? "bg-rose-500/20 text-rose-400"
              : "bg-zinc-700 text-zinc-300"
          )}
        >
          {timeAway.text}
        </Badge>
      </div>

      {/* Row 2: Date and time - Fixed height with top margin */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 mt-3 h-5 shrink-0">
        <Calendar className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{format(event.startsAt, "EEE, d MMM yyyy")}</span>
        <span className="text-zinc-600 shrink-0">•</span>
        <span className="shrink-0">{format(event.startsAt, "h:mm a")}</span>
      </div>

      {/* Spacer to push footer to bottom */}
      <div className="flex-1" />

      {/* Row 3: Badges and action - Fixed at bottom */}
      <div className="flex items-center justify-between gap-2 h-8 shrink-0">
        <div className="flex items-center gap-1.5 overflow-hidden">
          <Badge className="text-[10px] font-medium px-2 py-0.5 bg-transparent border border-zinc-600 text-zinc-300 shrink-0 rounded-md">
            {typeLabel}
          </Badge>
          <Badge className={cn("text-[10px] font-semibold px-2 py-0.5 border-0 shrink-0", statusStyle.bg, statusStyle.text)}>
            {event.status.replace(/_/g, " ")}
          </Badge>
        </div>
        <Button
          size="sm"
          className="h-7 px-3 text-xs bg-white hover:bg-zinc-100 text-zinc-900 font-semibold rounded-md shrink-0"
        >
          <Video className="h-3 w-3 mr-1" />
          Join
        </Button>
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
  // Type labels - border style
  const typeLabels: Record<string, string> = {
    consultation: "Consultation",
    subscription: "Subscription",
    class: "Class",
    webinar: "Webinar",
  };

  // Status badges - refined professional colors for light background
  const statusConfig: Record<string, { bg: string; text: string }> = {
    APPROVED: { bg: "bg-teal-50", text: "text-teal-600" },            // Teal - sophisticated success
    PENDING: { bg: "bg-orange-50", text: "text-orange-600" },         // Orange - warm urgency
    SCHEDULED: { bg: "bg-indigo-50", text: "text-indigo-600" },       // Indigo - elegant upcoming
    IN_PROGRESS: { bg: "bg-cyan-50", text: "text-cyan-600" },         // Cyan - bright active
    COMPLETED: { bg: "bg-slate-100", text: "text-slate-500" },        // Slate - warm done
    CANCELLED: { bg: "bg-stone-100", text: "text-stone-400" },        // Stone - neutral inactive
    REJECTED: { bg: "bg-red-50", text: "text-red-600" },              // Red - clear negative
  };

  const typeLabel = typeLabels[event.type] || "Event";
  const statusStyle = statusConfig[event.status] || statusConfig.PENDING;

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <div
        onClick={onToggle}
        className="flex items-center gap-4 p-4 cursor-pointer hover:bg-zinc-50/50 transition-colors"
      >
        <Avatar className="h-10 w-10 ring-1 ring-zinc-200">
          <AvatarImage src={event.consultantImage} alt={event.consultantName} />
          <AvatarFallback className="bg-zinc-100 text-zinc-600 text-xs font-medium">
            {event.consultantName.split(" ").map((n) => n[0]).join("")}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-zinc-900 text-sm">{event.title}</h4>
          <p className="text-xs text-zinc-500">{event.consultantName}</p>
        </div>
        <Badge className="text-[10px] font-medium bg-transparent border border-zinc-300 text-zinc-600 rounded-md">
          {typeLabel}
        </Badge>
        <Badge className={cn("text-[10px] font-medium border-0", statusStyle.bg, statusStyle.text)}>
          {event.status.replace(/_/g, " ")}
        </Badge>
        <ChevronRight
          className={cn(
            "h-4 w-4 text-zinc-400 transition-transform duration-200",
            isExpanded && "rotate-90"
          )}
        />
      </div>

      {/* Expanded slots */}
      {isExpanded && event.slots.length > 0 && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="pl-16 pr-4 pb-4"
        >
          <div className="space-y-2 bg-zinc-50 rounded-lg p-3">
            {event.slots.slice(0, 10).map((slot, idx) => (
              <div
                key={idx}
                className="flex items-center gap-4 text-sm text-zinc-600"
              >
                <span className="w-24 font-medium text-zinc-700">
                  {format(slot.startsAt, "EEE d MMM")}
                </span>
                <span className="text-zinc-500">
                  {format(slot.startsAt, "h:mm a")} - {format(slot.endsAt, "h:mm a")}
                </span>
              </div>
            ))}
            {event.slots.length > 10 && (
              <p className="text-xs text-zinc-400 pt-1">
                +{event.slots.length - 10} more sessions
              </p>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}

// Premium Features Card - Modern gradient design
function PremiumFeaturesCard() {
  return (
    <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 rounded-2xl border border-zinc-800 p-6 shadow-xl">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
          <Crown className="h-4 w-4 text-white" />
        </div>
        <h3 className="font-semibold text-white">Unlock Premium</h3>
      </div>
      
      <div className="space-y-3 mb-6">
        {[
          "Unlimited Access to Expert Sessions",
          "24/7 Priority Support",
          "Exclusive Webinars & Workshops",
        ].map((feature) => (
          <div key={feature} className="flex items-center gap-2.5 text-sm text-zinc-300">
            <div className="h-5 w-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <Check className="h-3 w-3 text-emerald-400" />
            </div>
            <span>{feature}</span>
          </div>
        ))}
      </div>
      
      <div className="mb-5">
        <span className="text-3xl font-bold text-white">$99</span>
        <span className="text-zinc-400">/month</span>
        <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
          <Zap className="h-3 w-3" />
          Save 20% with annual billing
        </p>
      </div>
      
      <Button className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-semibold h-11">
        <Crown className="h-4 w-4 mr-2" />
        Upgrade Now
      </Button>
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

  // Process events into unified format
  const processedEvents = useMemo(() => {
    const events: ProcessedEvent[] = [];

    // Process consultations
    eventsData.consultations?.forEach((c: any) => {
      const slots = c.appointment?.slotsOfAppointment || [];
      if (slots.length > 0) {
        const firstSlot = slots[0];
        events.push({
          id: c.id,
          type: "consultation",
          title: c.consultationPlan?.title || "Consultation",
          consultantName: c.consultationPlan?.consultantProfile?.user?.name || "Expert",
          consultantImage: c.consultationPlan?.consultantProfile?.user?.image,
          startsAt: new Date(firstSlot.startsAt),
          endsAt: new Date(firstSlot.endsAt),
          status: c.requestStatus || "PENDING",
          slots: slots.map((s: any) => ({
            startsAt: new Date(s.startsAt),
            endsAt: new Date(s.endsAt),
          })),
          appointmentId: c.appointment?.id,
        });
      }
    });

    // Process subscriptions
    eventsData.subscriptions?.forEach((s: any) => {
      const allSlots: Array<{ startsAt: Date; endsAt: Date }> = [];
      s.appointments?.forEach((a: any) => {
        a.slotsOfAppointment?.forEach((slot: any) => {
          allSlots.push({
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
          });
        });
      });

      if (allSlots.length > 0) {
        allSlots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        const nextSlot = allSlots.find((slot) => slot.startsAt > new Date()) || allSlots[0];

        events.push({
          id: s.id,
          type: "subscription",
          title: s.subscriptionPlan?.title || "Subscription",
          consultantName: s.subscriptionPlan?.consultantProfile?.user?.name || "Expert",
          consultantImage: s.subscriptionPlan?.consultantProfile?.user?.image,
          startsAt: nextSlot.startsAt,
          endsAt: nextSlot.endsAt,
          status: s.requestStatus || "PENDING",
          slots: allSlots,
          appointmentId: s.appointments?.[0]?.id,
        });
      }
    });

    // Process webinars
    eventsData.webinars?.forEach((w: any) => {
      const webinarData = w.webinar || w;
      const slots: Array<{ startsAt: Date; endsAt: Date }> = [];
      
      webinarData.appointments?.forEach((a: any) => {
        a.slotsOfAppointment?.forEach((slot: any) => {
          slots.push({
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
          });
        });
      });

      if (slots.length > 0) {
        slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        const nextSlot = slots.find((slot) => slot.startsAt > new Date()) || slots[0];

        events.push({
          id: w.id,
          type: "webinar",
          title: webinarData.webinarPlan?.title || "Webinar",
          consultantName: webinarData.webinarPlan?.consultantProfile?.user?.name || "Expert",
          consultantImage: webinarData.webinarPlan?.consultantProfile?.user?.image,
          startsAt: nextSlot.startsAt,
          endsAt: nextSlot.endsAt,
          status: w.status || "APPROVED",
          slots,
          appointmentId: webinarData.appointments?.[0]?.id,
        });
      }
    });

    // Process classes
    eventsData.classes?.forEach((c: any) => {
      const classData = c.class || c;
      const slots: Array<{ startsAt: Date; endsAt: Date }> = [];
      
      classData.appointments?.forEach((a: any) => {
        a.slotsOfAppointment?.forEach((slot: any) => {
          slots.push({
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
          });
        });
      });

      if (slots.length > 0) {
        slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        const nextSlot = slots.find((slot) => slot.startsAt > new Date()) || slots[0];

        events.push({
          id: c.id,
          type: "class",
          title: classData.classPlan?.title || "Class",
          consultantName: classData.classPlan?.consultantProfile?.user?.name || "Expert",
          consultantImage: classData.classPlan?.consultantProfile?.user?.image,
          startsAt: nextSlot.startsAt,
          endsAt: nextSlot.endsAt,
          status: c.status || "APPROVED",
          slots,
          appointmentId: classData.appointments?.[0]?.id,
        });
      }
    });

    return events;
  }, [eventsData]);

  // Get upcoming events
  const upcomingEvents = useMemo(() => {
    const now = new Date();
    return processedEvents
      .filter((e) => e.startsAt > now || e.slots.some((s) => s.startsAt > now))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }, [processedEvents]);

  // Get events for current month
  const monthlyEvents = useMemo(() => {
    return processedEvents.filter((e) =>
      e.slots.some((s) => isSameMonth(s.startsAt, currentMonth))
    );
  }, [processedEvents, currentMonth]);

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
        <div className="fixed top-20 right-4 bg-zinc-900 text-white px-4 py-2 rounded-lg text-sm z-50 shadow-lg flex items-center gap-2">
          <div className="h-3 w-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          Refreshing...
        </div>
      )}

      {/* Welcome Section - Dark elegant hero */}
      <motion.div variants={fadeInUp}>
        <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 rounded-2xl p-8 border border-zinc-800 shadow-2xl relative overflow-hidden">
          {/* Subtle grid pattern */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:32px_32px]" />
          
          <div className="relative">
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
              Welcome back, {userDetails.name?.split(" ")[0]}
            </h1>
            <p className="text-zinc-400 text-lg">
              Here's what's coming up in your learning journey
            </p>
            
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                onClick={() => router.push(`/dashboard/consultee/${consulteeId}/appointments`)}
                className="bg-white hover:bg-zinc-100 text-zinc-900 font-semibold h-11 px-5"
              >
                <Calendar className="h-4 w-4 mr-2" />
                View Schedule
              </Button>
              <Button
                variant="outline"
                onClick={() => router.push("/explore/experts")}
                className="border-zinc-700 bg-zinc-800/50 text-white hover:bg-zinc-800 h-11 px-5"
              >
                <Users className="h-4 w-4 mr-2" />
                Find Experts
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Upcoming Sessions - Dark cards with horizontal scroll */}
      <motion.div variants={fadeInUp}>
        <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden shadow-sm">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
            <h2 className="font-semibold text-zinc-900 text-lg">Upcoming Sessions</h2>
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

          <div className="p-5 bg-gradient-to-b from-zinc-50/50 to-white">
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
                    onClick={() =>
                      router.push(`/dashboard/consultee/${consulteeId}/appointments`)
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-16">
                <div className="mx-auto h-16 w-16 rounded-2xl bg-zinc-100 flex items-center justify-center mb-4">
                  <Calendar className="h-8 w-8 text-zinc-400" />
                </div>
                <h4 className="font-semibold text-zinc-900 text-lg">No upcoming sessions</h4>
                <p className="text-sm text-zinc-500 mt-1 mb-5">
                  Book a session with an expert to get started
                </p>
                <Button
                  className="bg-zinc-900 hover:bg-zinc-800 text-white"
                  onClick={() => router.push("/explore/experts")}
                >
                  <Users className="h-4 w-4 mr-2" />
                  Find Experts
                </Button>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* Main content grid */}
      <motion.div variants={fadeInUp} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monthly Schedule */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
              <h2 className="font-semibold text-zinc-900 text-lg">
                {format(currentMonth, "MMMM yyyy")}
              </h2>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() =>
                    setCurrentMonth(
                      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
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
                      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
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
                  <Calendar className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
                  <p className="text-zinc-500">No sessions scheduled for this month</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-6">
          <PremiumFeaturesCard />
          <PendingPaymentsWidget consulteeId={consulteeId} />
        </div>
      </motion.div>
    </motion.div>
  );
}
