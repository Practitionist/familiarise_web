"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import {
  Clock,
  X,
  Video,
  Calendar,
  Loader2,
  CalendarClock,
  CalendarRange,
  AlertCircle,
  CheckSquare,
  Check,
  CreditCard,
} from "lucide-react";
import React from "react";
import { DocumentUpload } from "./DocumentUpload";
import { cn } from "@/utils/tailwind";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import { ReportIssueDialog } from "./ReportIssueDialog";
import { CancelConfirmationDialog } from "./CancelConfirmationDialog";
import type { AppointmentStatus } from "@/utils/supportTicketUrl";
import type { TAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";
import {
  WaitlistStatusBadge,
  type BookingStatus,
} from "@/components/ui/waitlist-status-badge";

interface EventCardProps {
  title: string;
  consultant: string;
  date: string;
  status?: string;
  image?: string | null;
  actualSlots?: Array<{
    startTime: Date;
    endTime: Date;
  }>;
  type?: "Subscription" | "Class" | "Consultation" | "Webinar" | "Trial";
  isTentative?: boolean;
  appointmentId?: string;
  className?: string;
  appointment?: TAppointment;
  rawSlots?: SlotOfAppointment[];
  pendingPaymentUrl?: string | null;
  // Booking status for webinars/classes
  bookingStatus?: BookingStatus;
  waitlistPosition?: number;
}

function formatSlotDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "EEE, d MMM yyyy");
}

function formatSlotTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "h:mm a");
}

// Default meeting duration in milliseconds (1 hour)
const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

// Status configuration - refined professional colors
const statusConfig: Record<
  string,
  { bg: string; text: string; dot: string; label?: string }
> = {
  APPROVED: { bg: "bg-teal-50", text: "text-teal-600", dot: "bg-teal-500" }, // Teal - sophisticated success
  PENDING: {
    bg: "bg-orange-50",
    text: "text-orange-600",
    dot: "bg-orange-500",
  }, // Orange - warm urgency
  APPROVED_PENDING_PAYMENT: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    dot: "bg-amber-500",
    label: "PAYMENT REQUIRED",
  }, // Amber - payment action needed
  SCHEDULED: {
    bg: "bg-indigo-50",
    text: "text-indigo-600",
    dot: "bg-indigo-500",
  }, // Indigo - elegant upcoming
  IN_PROGRESS: {
    bg: "bg-cyan-50",
    text: "text-cyan-600",
    dot: "bg-cyan-500",
  }, // Cyan - bright active
  COMPLETED: {
    bg: "bg-slate-100",
    text: "text-slate-500",
    dot: "bg-slate-400",
  }, // Slate - warm done
  CANCELLED: {
    bg: "bg-stone-100",
    text: "text-stone-400",
    dot: "bg-stone-400",
  }, // Stone - neutral inactive
  REJECTED: { bg: "bg-red-50", text: "text-red-600", dot: "bg-red-500" }, // Red - clear negative
};

export function EventCard({
  title,
  consultant,
  date,
  status = "Active",
  image,
  actualSlots = [],
  type = "Consultation",
  isTentative = false,
  appointmentId,
  className = "",
  appointment,
  rawSlots = [],
  pendingPaymentUrl,
  bookingStatus,
  waitlistPosition,
}: Readonly<EventCardProps>) {
  const { toast } = useToast();
  const router = useRouter();
  const client = useStreamVideoClient();
  const [isLoading, setIsLoading] = React.useState(false);
  const [isJoining, setIsJoining] = React.useState(false);

  // Reschedule dialog state
  const [showRescheduleDialog, setShowRescheduleDialog] = React.useState(false);
  const [rescheduleType, setRescheduleType] = React.useState<
    "individual" | "multiple" | "entire"
  >("entire");
  const [selectedSlotIds, setSelectedSlotIds] = React.useState<string[]>([]);

  // Report Issue dialog state
  const [showReportDialog, setShowReportDialog] = React.useState(false);

  // Cancel confirmation dialog state
  const [showCancelDialog, setShowCancelDialog] = React.useState(false);

  // Get appointment status and type for issue filtering
  const appointmentStatus: AppointmentStatus =
    status?.toLowerCase() === "completed" ? "COMPLETED" : "UPCOMING";

  const appointmentType: "CONSULTATION" | "SUBSCRIPTION" =
    type === "Subscription" ? "SUBSCRIPTION" : "CONSULTATION";

  // Get the first slot's scheduled time for context
  const scheduledAt =
    rawSlots && rawSlots.length > 0
      ? new Date(rawSlots[0].startsAt).toISOString()
      : undefined;

  // Memoize expensive session grouping - only re-runs when rawSlots changes
  const groupedSessions = React.useMemo(() => {
    const sortedSlots = rawSlots
      .filter((slot) => !slot.isTentative)
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );

    // Helper to create session object (eliminates duplication)
    const createSession = (slots: typeof sortedSlots) => {
      if (slots.length === 0) return null;
      return {
        slots: [...slots],
        startTime: new Date(slots[0].startsAt),
        endTime: new Date(slots[slots.length - 1].endsAt),
      };
    };

    const sessions: Array<{
      slots: typeof sortedSlots;
      startTime: Date;
      endTime: Date;
    }> = [];

    let currentSessionSlots: typeof sortedSlots = [];

    for (let i = 0; i < sortedSlots.length; i++) {
      const slot = sortedSlots[i];
      const prevSlot = sortedSlots[i - 1];

      if (i === 0) {
        currentSessionSlots.push(slot);
      } else {
        const prevEnd = new Date(prevSlot.endsAt).getTime();
        const currStart = new Date(slot.startsAt).getTime();

        if (currStart === prevEnd) {
          currentSessionSlots.push(slot);
        } else {
          const session = createSession(currentSessionSlots);
          if (session) sessions.push(session);
          currentSessionSlots = [slot];
        }
      }
    }

    // Last session (using helper - no duplication)
    const lastSession = createSession(currentSessionSlots);
    if (lastSession) sessions.push(lastSession);

    return sessions;
  }, [rawSlots]);

  // Derive dynamic isWithin24Hours on each render (cheap operation, stays fresh)
  const sessionsWithDynamicProps = groupedSessions.map((session) => ({
    ...session,
    isWithin24Hours:
      (session.startTime.getTime() - Date.now()) / (1000 * 60 * 60) < 24,
  }));

  // Memoize selected session count calculation
  const selectedSessionCount = React.useMemo(() => {
    return groupedSessions.filter((session) =>
      session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
    ).length;
  }, [groupedSessions, selectedSlotIds]);

  const showSessionDetails =
    (type === "Subscription" || type === "Class") &&
    actualSlots &&
    actualSlots.length > 1;

  // Check if this is a subscription with multiple sessions (for reschedule options)
  const isMultiSessionSubscription =
    type === "Subscription" && rawSlots.length > 1;

  // Handle reschedule button click - show dialog for subscriptions with multiple sessions
  const handleRescheduleClick = () => {
    if (isMultiSessionSubscription) {
      // Reset dialog state
      setRescheduleType("entire");
      setSelectedSlotIds([]);
      setShowRescheduleDialog(true);
    } else {
      // For consultations or single-session subscriptions, reschedule directly
      handleReschedule();
    }
  };

  // Execute the reschedule API call
  const handleReschedule = async (slotIds?: string[]) => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setShowRescheduleDialog(false);

    try {
      // Build the URL with type parameter for subscriptions
      const url =
        type === "Subscription"
          ? `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`
          : `/api/appointments/${appointmentId}/reschedule`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Include slotIds in body for individual/multiple session reschedule
        body:
          slotIds && slotIds.length > 0
            ? JSON.stringify({ slotIds })
            : undefined,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to request reschedule");
      }

      const slotsAffected =
        data.slotsAffected ?? slotIds?.length ?? rawSlots.length;

      toast({
        title: "Ready to reschedule",
        description:
          slotsAffected === 1
            ? `Select a new time for your session.`
            : `Select new times for your ${slotsAffected} sessions.`,
      });

      window.location.reload();
    } catch (error) {
      console.error("Error requesting reschedule:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to request reschedule",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle dialog confirmation
  const handleRescheduleConfirm = () => {
    if (
      (rescheduleType === "individual" || rescheduleType === "multiple") &&
      selectedSlotIds.length > 0
    ) {
      handleReschedule(selectedSlotIds);
    } else {
      handleReschedule();
    }
  };

  // Open cancel confirmation dialog
  const handleCancelClick = () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }
    setShowCancelDialog(true);
  };

  // Execute the cancel API call
  const handleCancelConfirm = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to cancel appointment");
      }

      toast({
        title: "Appointment cancelled",
        description: `Your ${type.toLowerCase()} "${title}" has been cancelled successfully.`,
      });

      setShowCancelDialog(false);
      window.location.reload();
    } catch (error) {
      console.error("Error cancelling appointment:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to cancel appointment",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Find the current/next joinable slot (within 10 minutes of start time or currently ongoing)
  const getJoinableSlot = (): SlotOfAppointment | null => {
    if (!rawSlots || rawSlots.length === 0) return null;

    const now = new Date();

    for (const slot of rawSlots) {
      const startTime = new Date(slot.startsAt);
      const endTime = slot.endsAt
        ? new Date(slot.endsAt)
        : new Date(startTime.getTime() + DEFAULT_MEETING_DURATION_MS);

      // Joinable if: current time is between (10 mins before start) and (actual end time)
      const joinWindowStart = new Date(startTime.getTime() - 10 * 60 * 1000);
      const isJoinable = now >= joinWindowStart && now <= endTime;

      if (!slot.isTentative && isJoinable) {
        return slot;
      }
    }

    return null;
  };

  const joinableSlot = getJoinableSlot();
  const isJoinable = !isTentative && !!joinableSlot && !!appointment;

  // Dev mode: check if any slot exists for testing
  const isDev = process.env.NODE_ENV === "development";
  const hasAnySlot = rawSlots && rawSlots.length > 0;
  const canDevJoin = isDev && hasAnySlot && !!appointment;

  const handleJoinSession = async (forceSlot?: SlotOfAppointment) => {
    const slotToUse = forceSlot || joinableSlot;

    if (!client) {
      toast({
        title: "Not signed in",
        description:
          "Video client not initialized. Please sign in to join the meeting.",
        variant: "destructive",
      });
      return;
    }

    if (!appointment || !slotToUse) {
      toast({
        title: "Unable to join",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }

    setIsJoining(true);
    try {
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        slotToUse,
      );

      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting room.",
      });

      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive",
      });
      setIsJoining(false);
    }
  };

  // Determine if actions should be disabled (negative/terminal statuses)
  const isInactiveStatus =
    status?.toLowerCase() === "cancelled" ||
    status?.toLowerCase() === "rejected" ||
    status?.toLowerCase() === "completed" ||
    status?.toLowerCase() === "expired";

  const showDocumentUpload =
    (type === "Consultation" || type === "Subscription") && appointmentId;

  const statusStyle =
    statusConfig[status?.toUpperCase()] || statusConfig.PENDING;
  const displayStatus = isTentative ? "PENDING" : status?.toUpperCase();
  const displayStatusStyle = isTentative ? statusConfig.PENDING : statusStyle;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`w-full h-full ${className}`}
    >
      <div className="bg-white rounded-xl border border-zinc-200 p-4 hover:border-zinc-300 hover:shadow-md transition-all duration-200 h-full flex flex-col">
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <Avatar className="h-11 w-11 ring-2 ring-zinc-100">
            <AvatarImage alt={consultant} src={image || undefined} />
            <AvatarFallback className="bg-gradient-to-br from-zinc-100 to-zinc-200 text-zinc-600 text-sm font-semibold">
              {consultant
                ?.split(" ")
                .slice(0, 2)
                .map((name) => name[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3
              className="font-semibold text-zinc-900 text-sm leading-tight line-clamp-2 mb-1"
              title={title}
            >
              {title}
            </h3>
            <p
              className="text-xs text-zinc-500 line-clamp-1"
              title={consultant}
            >
              {consultant}
            </p>
          </div>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Badge className="text-[10px] font-medium px-2 py-0.5 bg-transparent border border-zinc-300 text-zinc-600 rounded-md">
            {type === "Trial" ? "Subscription" : type}
          </Badge>
          {type === "Trial" && (
            <Badge className="text-[10px] font-semibold px-2 py-0.5 bg-emerald-50 text-emerald-700 border-0 rounded-md">
              Free Trial
            </Badge>
          )}
          {/* Show booking status badge for webinars and classes */}
          {(type === "Webinar" || type === "Class") && bookingStatus ? (
            <WaitlistStatusBadge
              bookingStatus={bookingStatus}
              waitlistPosition={waitlistPosition}
              size="sm"
              showIcon={false}
            />
          ) : (
            <Badge
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 border-0 flex items-center gap-1",
                displayStatusStyle.bg,
                displayStatusStyle.text,
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  displayStatusStyle.dot,
                )}
              />
              {displayStatusStyle.label || displayStatus?.replace(/_/g, " ")}
            </Badge>
          )}
        </div>

        {/* Schedule Section */}
        <div className="flex-1">
          {type === "Class" && actualSlots.length === 1 ? (
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1.5">
                <Calendar className="h-3.5 w-3.5" />
                <span>Scheduled Time</span>
              </div>
              <div className="text-sm text-zinc-700 font-medium">
                {formatSlotDate(actualSlots[0].startTime)}
              </div>
              <div className="text-sm text-zinc-500">
                {formatSlotTime(actualSlots[0].startTime)} -{" "}
                {formatSlotTime(actualSlots[0].endTime)}
              </div>
            </div>
          ) : showSessionDetails ? (
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem
                value="sessions"
                className="border border-zinc-100 rounded-lg overflow-hidden"
              >
                <AccordionTrigger className="py-2.5 px-3 hover:no-underline hover:bg-zinc-50 text-left [&[data-state=open]>svg]:rotate-180">
                  <div className="flex items-center gap-2 text-sm text-zinc-700 font-medium">
                    <Calendar className="h-4 w-4 text-zinc-400" />
                    {actualSlots.length} Sessions
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="px-3 pb-3 space-y-2 max-h-32 overflow-y-auto">
                    {actualSlots.map((slot, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between bg-zinc-50 p-2 rounded-lg text-xs"
                      >
                        <span className="text-zinc-700 font-medium">
                          {formatSlotDate(slot.startTime)}
                        </span>
                        <span className="text-zinc-500">
                          {formatSlotTime(slot.startTime)} -{" "}
                          {formatSlotTime(slot.endTime)}
                        </span>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : type === "Consultation" && rawSlots.length > 0 ? (
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1.5">
                <Calendar className="h-3.5 w-3.5" />
                <span>Scheduled Time</span>
              </div>
              <div className="text-sm text-zinc-700 font-medium">
                {formatSlotDate(rawSlots[0].startsAt)}
              </div>
              <div className="text-sm text-zinc-500">
                {formatSlotTime(rawSlots[0].startsAt)} -{" "}
                {formatSlotTime(rawSlots[0].endsAt)}
              </div>
            </div>
          ) : type !== "Webinar" ? (
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                <Clock className="h-3.5 w-3.5" />
                <span>Next Session</span>
              </div>
              <div className="text-sm text-zinc-700">{date}</div>
            </div>
          ) : null}
        </div>

        {/* Document Upload - Always render for consistency, disabled when inactive */}
        {showDocumentUpload && (
          <div
            className={cn(
              "mt-4 pt-4 border-t border-zinc-100",
              isInactiveStatus && "opacity-50 pointer-events-none",
            )}
          >
            <DocumentUpload
              appointmentId={appointmentId!}
              appointmentTitle={title}
              appointmentType={type}
            />
          </div>
        )}

        {/* Pay Now Button - for APPROVED_PENDING_PAYMENT status */}
        {status?.toUpperCase() === "APPROVED_PENDING_PAYMENT" &&
          pendingPaymentUrl && (
            <div className="mt-4 pt-4 border-t border-zinc-100">
              <Button
                size="sm"
                onClick={() => window.open(pendingPaymentUrl, "_blank")}
                className="w-full h-9 text-sm font-medium bg-amber-500 hover:bg-amber-600 text-white"
              >
                <CreditCard className="h-4 w-4 mr-2" />
                Pay Now to Confirm
              </Button>
              <p className="text-xs text-amber-600 text-center mt-2">
                Complete payment to confirm your appointment
              </p>
            </div>
          )}

        {/* Action Buttons - Always render for consistency */}
        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-zinc-100">
          {!isTentative && status?.toUpperCase() === "APPROVED" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRescheduleClick}
              disabled={isLoading || isInactiveStatus}
              className={cn(
                "flex-1 h-8 text-xs font-medium border-zinc-200",
                isInactiveStatus
                  ? "text-zinc-400 bg-zinc-50 cursor-not-allowed"
                  : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50",
              )}
            >
              <Clock className="h-3.5 w-3.5 mr-1.5" />
              Reschedule
            </Button>
          )}
          {!isInactiveStatus &&
            status?.toUpperCase() !== "APPROVED_PENDING_PAYMENT" && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancelClick}
                disabled={isLoading}
                className="flex-1 h-8 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 hover:border-red-300"
              >
                <X className="h-3.5 w-3.5 mr-1.5" />
                Cancel
              </Button>
            )}
        </div>

        {/* Report Issue Button - Always visible for getting help with appointments */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowReportDialog(true)}
          disabled={!appointmentId}
          className="w-full mt-2 h-8 text-xs font-medium text-amber-600 hover:text-amber-700 hover:bg-amber-50 border-amber-200 hover:border-amber-300"
        >
          <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
          Report Issue
        </Button>

        {/* Join Button - Always render for consistency */}
        <Button
          onClick={() => handleJoinSession()}
          disabled={!isJoinable || isInactiveStatus || isJoining}
          className={cn(
            "w-full mt-3 h-9 font-medium text-sm",
            isJoinable && !isInactiveStatus && !isJoining
              ? "bg-zinc-900 hover:bg-zinc-800 text-white"
              : "bg-zinc-100 text-zinc-400 cursor-not-allowed",
          )}
        >
          {isJoining ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Joining...
            </>
          ) : (
            <>
              <Video className="h-4 w-4 mr-2" />
              Join Session
            </>
          )}
        </Button>

        {/* Dev-only Join Button - bypasses time check for testing */}
        {canDevJoin && !isJoinable && (
          <Button
            onClick={() => handleJoinSession(rawSlots[0])}
            disabled={isInactiveStatus || isJoining}
            className="w-full mt-2 h-8 font-medium text-xs bg-amber-500 hover:bg-amber-600 text-white"
          >
            {isJoining ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Joining...
              </>
            ) : (
              <>
                <Video className="h-3.5 w-3.5 mr-1.5" />
                Join (dev)
              </>
            )}
          </Button>
        )}
      </div>

      {/* Reschedule Dialog for Subscriptions with Multiple Sessions */}
      <Dialog
        open={showRescheduleDialog}
        onOpenChange={setShowRescheduleDialog}
      >
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-hide">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-zinc-600" />
              Reschedule Options
            </DialogTitle>
            <DialogDescription>
              Choose how you&apos;d like to reschedule your subscription
              sessions.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-4">
            <RadioGroup
              value={rescheduleType}
              onValueChange={(value) => {
                setRescheduleType(
                  value as "individual" | "multiple" | "entire",
                );
                if (value === "entire") {
                  setSelectedSlotIds([]);
                } else if (value === "individual") {
                  // Reset to single selection mode
                  setSelectedSlotIds(selectedSlotIds.slice(0, 1));
                }
              }}
              className="space-y-3"
            >
              {/* Reschedule One Session Option */}
              <div
                className={cn(
                  "flex items-start space-x-3 p-3 rounded-lg border transition-colors",
                  rescheduleType === "individual"
                    ? "border-zinc-900 bg-zinc-50"
                    : "border-zinc-200 hover:border-zinc-300",
                )}
              >
                <RadioGroupItem
                  value="individual"
                  id="individual"
                  className="mt-1"
                />
                <Label htmlFor="individual" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-2 font-medium text-zinc-900">
                    <CalendarClock className="h-4 w-4" />
                    Reschedule One Session
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    Only the selected session will be rescheduled. Other
                    sessions remain unchanged.
                  </p>
                </Label>
              </div>

              {/* Reschedule Multiple Sessions Option */}
              <div
                className={cn(
                  "flex items-start space-x-3 p-3 rounded-lg border transition-colors",
                  rescheduleType === "multiple"
                    ? "border-zinc-900 bg-zinc-50"
                    : "border-zinc-200 hover:border-zinc-300",
                )}
              >
                <RadioGroupItem
                  value="multiple"
                  id="multiple"
                  className="mt-1"
                />
                <Label htmlFor="multiple" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-2 font-medium text-zinc-900">
                    <CheckSquare className="h-4 w-4" />
                    Reschedule Multiple Sessions
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    Select specific sessions to reschedule. Other sessions
                    remain unchanged.
                  </p>
                </Label>
              </div>

              {/* Reschedule Entire Subscription Option */}
              <div
                className={cn(
                  "flex items-start space-x-3 p-3 rounded-lg border transition-colors",
                  rescheduleType === "entire"
                    ? "border-zinc-900 bg-zinc-50"
                    : "border-zinc-200 hover:border-zinc-300",
                )}
              >
                <RadioGroupItem value="entire" id="entire" className="mt-1" />
                <Label htmlFor="entire" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-2 font-medium text-zinc-900">
                    <CalendarRange className="h-4 w-4" />
                    Reschedule Entire Subscription
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    All {rawSlots.length} sessions will be released. You&apos;ll
                    need to select new times for all sessions.
                  </p>
                </Label>
              </div>
            </RadioGroup>

            {/* Session Selector - shown when "individual" or "multiple" is selected */}
            {(rescheduleType === "individual" ||
              rescheduleType === "multiple") && (
              <div className="mt-4 space-y-2">
                <Label className="text-sm font-medium text-zinc-700">
                  {rescheduleType === "individual"
                    ? "Select the session to reschedule:"
                    : "Select sessions to reschedule:"}
                </Label>
                <div className="max-h-48 overflow-y-auto space-y-2 rounded-lg border border-zinc-200 p-2">
                  {sessionsWithDynamicProps.map((session, sessionIndex) => {
                    // Get all slot IDs for this session
                    const sessionSlotIds = session.slots.map((s) => s.id);
                    // Session is selected if ALL its slots are in selectedSlotIds
                    const isSelected = sessionSlotIds.every((id) =>
                      selectedSlotIds.includes(id),
                    );

                    const handleSessionClick = () => {
                      if (session.isWithin24Hours) return;

                      if (rescheduleType === "individual") {
                        // Single select mode - select ALL slots in this session
                        setSelectedSlotIds(sessionSlotIds);
                      } else {
                        // Multi-select mode - toggle ALL slots in this session
                        if (isSelected) {
                          // Deselect all slots in this session
                          setSelectedSlotIds((prev) =>
                            prev.filter((id) => !sessionSlotIds.includes(id)),
                          );
                        } else {
                          // Select all slots in this session
                          setSelectedSlotIds((prev) => {
                            const combined = [...prev, ...sessionSlotIds];
                            return Array.from(new Set(combined));
                          });
                        }
                      }
                    };

                    return (
                      <button
                        key={`session-${sessionIndex}`}
                        type="button"
                        onClick={handleSessionClick}
                        disabled={session.isWithin24Hours}
                        className={cn(
                          "w-full flex items-center justify-between p-2.5 rounded-md text-left transition-colors",
                          isSelected
                            ? "bg-zinc-900 text-white"
                            : session.isWithin24Hours
                              ? "bg-zinc-100 text-zinc-400 cursor-not-allowed"
                              : "bg-zinc-50 hover:bg-zinc-100 text-zinc-700",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          {/* Checkbox indicator for multi-select mode */}
                          {rescheduleType === "multiple" && (
                            <div
                              className={cn(
                                "w-4 h-4 rounded border flex items-center justify-center",
                                isSelected
                                  ? "bg-white border-white"
                                  : session.isWithin24Hours
                                    ? "border-zinc-300"
                                    : "border-zinc-400",
                              )}
                            >
                              {isSelected && (
                                <Check className="h-3 w-3 text-zinc-900" />
                              )}
                            </div>
                          )}
                          <div>
                            <div className="text-sm font-medium">
                              {formatSlotDate(session.startTime)}
                            </div>
                            <div
                              className={cn(
                                "text-xs",
                                isSelected ? "text-zinc-300" : "text-zinc-500",
                              )}
                            >
                              {formatSlotTime(session.startTime)} -{" "}
                              {formatSlotTime(session.endTime)}
                            </div>
                          </div>
                        </div>
                        {session.isWithin24Hours && (
                          <span className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded">
                            Within 24h
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {sessionsWithDynamicProps.length === 0 && (
                  <p className="text-sm text-zinc-500 text-center py-4">
                    No confirmed sessions available to reschedule.
                  </p>
                )}
                {rescheduleType === "multiple" &&
                  selectedSlotIds.length > 0 && (
                    <p className="text-sm text-zinc-600 font-medium">
                      {selectedSessionCount} session
                      {selectedSessionCount > 1 ? "s" : ""} selected
                    </p>
                  )}
              </div>
            )}

            {/* Warning notice */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-800">
                <strong>Note:</strong> Sessions cannot be rescheduled within 24
                hours of the start time. No refunds are provided for
                rescheduling.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setShowRescheduleDialog(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRescheduleConfirm}
              disabled={
                isLoading ||
                ((rescheduleType === "individual" ||
                  rescheduleType === "multiple") &&
                  selectedSlotIds.length === 0)
              }
              className="bg-zinc-900 hover:bg-zinc-800"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                "Confirm Reschedule"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report Issue Dialog for appointment-linked issues */}
      {appointmentId && (
        <ReportIssueDialog
          open={showReportDialog}
          onOpenChange={setShowReportDialog}
          appointmentId={appointmentId}
          appointmentType={appointmentType}
          appointmentStatus={appointmentStatus}
          consultantName={consultant}
          scheduledAt={scheduledAt}
          onSuccess={() => {
            setShowReportDialog(false);
          }}
        />
      )}

      {/* Cancel Confirmation Dialog */}
      <CancelConfirmationDialog
        isOpen={showCancelDialog}
        onConfirm={handleCancelConfirm}
        onCancel={() => setShowCancelDialog(false)}
        title={title}
        consultant={consultant}
        appointmentType={type}
        isLoading={isLoading}
      />
    </motion.div>
  );
}
