"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { motion } from "framer-motion";
import {
  Clock,
  CalendarClock,
  CalendarRange,
  CheckSquare,
  Check,
  Loader2,
  CreditCard,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/utils/tailwind";
import type { TAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";
import type { BookingStatus } from "@/components/ui/waitlist-status-badge";
import {
  DEFAULT_MEETING_DURATION_MS,
  type SlotWithMeetingSession,
} from "../types";

import { CardHeader } from "./CardHeader";
import { StatusBadgeGroup } from "./StatusBadgeGroup";
import { SessionTimeline } from "./SessionTimeline";
import { OverflowMenu } from "./OverflowMenu";
import { useEventActions } from "./useEventActions";
import { DocumentUpload } from "../DocumentUpload";
import { ReportIssueDialog } from "../ReportIssueDialog";
import { CancelConfirmationDialog } from "../CancelConfirmationDialog";
import type { AppointmentStatus } from "@/utils/supportTicketUrl";

interface CollaboratorInfo {
  name: string;
  image?: string | null;
  role: string;
}

interface MultiSessionEventCardProps {
  title: string;
  consultant: string;
  image?: string | null;
  status: string;
  type: "Subscription" | "Class";
  isTentative: boolean;
  appointmentId?: string;
  appointment?: TAppointment;
  rawSlots: SlotOfAppointment[];
  allSlots: SlotWithMeetingSession[];
  pendingPaymentUrl?: string | null;
  bookingStatus?: BookingStatus;
  waitlistPosition?: number;
  collaborators?: CollaboratorInfo[];
  totalSessions?: number;
}

function formatSlotDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "EEE, d MMM yyyy");
}

function formatSlotTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "h:mm a");
}

export function MultiSessionEventCard({
  title,
  consultant,
  image,
  status,
  type,
  isTentative,
  appointmentId,
  appointment,
  rawSlots,
  allSlots,
  pendingPaymentUrl,
  bookingStatus,
  waitlistPosition,
  collaborators = [],
  totalSessions,
}: MultiSessionEventCardProps) {
  const actions = useEventActions({
    appointmentId,
    appointment,
    rawSlots,
    title,
    consultant,
    type,
  });

  // Reschedule dialog state for multi-session
  const [rescheduleType, setRescheduleType] = React.useState<
    "individual" | "multiple" | "entire"
  >("entire");
  const [selectedSlotIds, setSelectedSlotIds] = React.useState<string[]>([]);

  const isInactive =
    status?.toLowerCase() === "cancelled" ||
    status?.toLowerCase() === "rejected" ||
    status?.toLowerCase() === "completed" ||
    status?.toLowerCase() === "expired";

  const isPendingPayment = status?.toUpperCase() === "APPROVED_PENDING_PAYMENT";
  const isApproved = status?.toUpperCase() === "APPROVED";
  const isDev = process.env.NODE_ENV === "development";
  const canDevJoin = isDev && rawSlots.length > 0 && !!appointment;
  const showDocUpload =
    type === "Subscription" &&
    !!appointmentId &&
    !isPendingPayment &&
    !isInactive;

  const appointmentStatus: AppointmentStatus =
    status?.toLowerCase() === "completed" ? "COMPLETED" : "UPCOMING";

  const scheduledAt =
    rawSlots.length > 0
      ? new Date(rawSlots[0].startsAt).toISOString()
      : undefined;

  // Progress calculation — count sessions (appointment groups), not individual slots
  const nonTentativeSlots = allSlots.filter((s) => !s.isTentative);
  const sessionGroups = React.useMemo(() => {
    const slots = allSlots.filter((s) => !s.isTentative);
    const groups = new Map<string, SlotWithMeetingSession[]>();
    for (const s of slots) {
      const key = s.appointmentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    return groups;
  }, [allSlots]);
  const totalSessionCount = sessionGroups.size || 1;
  const completedCount = Array.from(sessionGroups.values()).filter((group) =>
    group.every((s) => {
      const end = s.endsAt
        ? new Date(s.endsAt).getTime()
        : new Date(s.startsAt).getTime() + DEFAULT_MEETING_DURATION_MS;
      return Date.now() > end && s.meetingSession?.endedAt;
    }),
  ).length;
  const total = totalSessions || totalSessionCount;
  const progressPercent = Math.round((completedCount / total) * 100);

  // Grouped sessions for reschedule dialog — group by appointmentId
  const groupedSessions = React.useMemo(() => {
    const nonTentative = rawSlots.filter((slot) => !slot.isTentative);
    const groups = new Map<string, typeof nonTentative>();
    for (const slot of nonTentative) {
      const key = slot.appointmentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(slot);
    }
    return Array.from(groups.values())
      .map((slots) => {
        const sorted = slots.sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        );
        return {
          slots: sorted,
          startTime: new Date(sorted[0].startsAt),
          endTime: new Date(sorted[sorted.length - 1].endsAt),
        };
      })
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }, [rawSlots]);

  const sessionsWithDynamicProps = groupedSessions.map((session) => ({
    ...session,
    isWithin24Hours:
      (session.startTime.getTime() - Date.now()) / (1000 * 60 * 60) < 24,
  }));

  const selectedSessionCount = React.useMemo(() => {
    return groupedSessions.filter((session) =>
      session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
    ).length;
  }, [groupedSessions, selectedSlotIds]);

  const handleRescheduleConfirm = () => {
    if (
      (rescheduleType === "individual" || rescheduleType === "multiple") &&
      selectedSlotIds.length > 0
    ) {
      actions.handleReschedule(selectedSlotIds);
    } else {
      actions.handleReschedule();
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="w-full h-full"
    >
      <div className="bg-white rounded-xl border border-zinc-200 p-4 hover:border-zinc-300 hover:shadow-md transition-all duration-200 h-full flex flex-col">
        {/* Header */}
        <div className="mb-3">
          <CardHeader
            title={title}
            consultant={consultant}
            image={image}
            collaborators={collaborators}
            metaLine={`${total} ${total === 1 ? "session" : "sessions"}`}
          />
        </div>

        {/* Badge group */}
        <div className="mb-3">
          <StatusBadgeGroup
            eventType={type}
            status={status}
            isTentative={isTentative}
            bookingStatus={bookingStatus}
            waitlistPosition={waitlistPosition}
          />
        </div>

        {/* Progress bar */}
        {!isInactive && nonTentativeSlots.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
              <span>Progress</span>
              <span className="font-medium text-zinc-700">
                {completedCount} of {total}
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
          </div>
        )}

        {/* Session timeline */}
        <div className="flex-1">
          {nonTentativeSlots.length > 0 ? (
            <SessionTimeline
              slots={allSlots}
              isJoining={actions.isJoining}
              onJoinSlot={(slot) => actions.handleJoinSession(slot)}
            />
          ) : (
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Clock className="h-3.5 w-3.5" />
                <span>
                  {isTentative
                    ? "Awaiting schedule confirmation"
                    : status?.toLowerCase() === "completed"
                      ? "Session details unavailable"
                      : isInactive
                        ? "No sessions were scheduled"
                        : "No sessions scheduled yet"}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Pay Now for pending payment */}
        {isPendingPayment && pendingPaymentUrl && (
          <div className="mt-3 pt-3 border-t border-zinc-100">
            <Button
              size="sm"
              onClick={() => {
                if (
                  pendingPaymentUrl &&
                  /^https?:\/\//.test(pendingPaymentUrl)
                ) {
                  window.open(
                    pendingPaymentUrl,
                    "_blank",
                    "noopener,noreferrer",
                  );
                }
              }}
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

        {/* Document upload — full width, subscriptions only */}
        {showDocUpload && (
          <div className="mt-3 pt-3 border-t border-zinc-100">
            <DocumentUpload
              appointmentId={appointmentId!}
              appointmentTitle={title}
              appointmentType={type}
            />
          </div>
        )}

        {/* Action bar — reschedule + overflow only (join is per-row in timeline) */}
        <div
          className={cn(
            "flex items-center gap-2",
            showDocUpload && !isInactive
              ? "mt-3"
              : "mt-3 pt-3 border-t border-zinc-100",
          )}
        >
          {!isTentative && isApproved && !isInactive ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRescheduleType("entire");
                setSelectedSlotIds([]);
                actions.setShowRescheduleDialog(true);
              }}
              disabled={actions.isLoading}
              className="flex-1 h-8 text-xs font-medium border-zinc-200 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50"
            >
              <Clock className="h-3.5 w-3.5 mr-1.5" />
              Reschedule
            </Button>
          ) : !isInactive ? (
            <div className="flex-1 text-xs text-zinc-400 text-center py-1">
              {isTentative
                ? "Awaiting confirmation"
                : isPendingPayment || bookingStatus === "CONFIRMED"
                  ? ""
                  : "Pending approval"}
            </div>
          ) : (
            <div className="flex-1 text-xs text-zinc-400 text-center py-1">
              {status}
            </div>
          )}
          <OverflowMenu
            eventType={type}
            isActive={!isInactive}
            isPendingPayment={isPendingPayment}
            hasAppointmentId={!!appointmentId}
            isDev={isDev}
            canDevJoin={canDevJoin && !actions.joinableSlot}
            isLoading={actions.isLoading}
            onCancel={actions.handleCancelClick}
            onReportIssue={() => actions.setShowReportDialog(true)}
            onDevJoin={() => actions.handleJoinSession(rawSlots[0])}
          />
        </div>
      </div>

      {/* Report Issue Dialog */}
      {appointmentId && (
        <ReportIssueDialog
          open={actions.showReportDialog}
          onOpenChange={actions.setShowReportDialog}
          appointmentId={appointmentId}
          appointmentType={type === "Class" ? "CLASS" : "SUBSCRIPTION"}
          appointmentStatus={appointmentStatus}
          consultantName={consultant}
          scheduledAt={scheduledAt}
          onSuccess={() => actions.setShowReportDialog(false)}
        />
      )}

      {/* Reschedule Dialog for Multi-Session */}
      <Dialog
        open={actions.showRescheduleDialog}
        onOpenChange={actions.setShowRescheduleDialog}
      >
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-hide">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-zinc-600" />
              Reschedule Options
            </DialogTitle>
            <DialogDescription>
              Choose how you&apos;d like to reschedule your {type.toLowerCase()}{" "}
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
                  // Auto-select the session containing the first selected slot
                  const firstSelectedId = selectedSlotIds[0];
                  const sessionWithFirst = groupedSessions.find((session) =>
                    session.slots.some((s) => s.id === firstSelectedId),
                  );
                  const first = sessionWithFirst
                    ? sessionWithFirst.slots.map((s) => s.id)
                    : groupedSessions.length > 0
                      ? groupedSessions[0].slots.map((s) => s.id)
                      : [];
                  setSelectedSlotIds(first);
                }
              }}
              className="space-y-3"
            >
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
                    Only the selected session will be rescheduled.
                  </p>
                </Label>
              </div>

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
                    Select specific sessions to reschedule.
                  </p>
                </Label>
              </div>

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
                    Reschedule Entire {type}
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    All {groupedSessions.length} sessions will be released.
                  </p>
                </Label>
              </div>
            </RadioGroup>

            {/* Session Selector */}
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
                    const sessionSlotIds = session.slots.map((s) => s.id);
                    const isSelected = sessionSlotIds.every((id) =>
                      selectedSlotIds.includes(id),
                    );

                    const handleSessionClick = () => {
                      if (session.isWithin24Hours) return;
                      if (rescheduleType === "individual") {
                        setSelectedSlotIds(sessionSlotIds);
                      } else {
                        if (isSelected) {
                          setSelectedSlotIds((prev) =>
                            prev.filter((id) => !sessionSlotIds.includes(id)),
                          );
                        } else {
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
                {rescheduleType === "multiple" &&
                  selectedSlotIds.length > 0 && (
                    <p className="text-sm text-zinc-600 font-medium">
                      {selectedSessionCount} session
                      {selectedSessionCount > 1 ? "s" : ""} selected
                    </p>
                  )}
              </div>
            )}

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
              onClick={() => actions.setShowRescheduleDialog(false)}
              disabled={actions.isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRescheduleConfirm}
              disabled={
                actions.isLoading ||
                ((rescheduleType === "individual" ||
                  rescheduleType === "multiple") &&
                  selectedSlotIds.length === 0)
              }
              className="bg-zinc-900 hover:bg-zinc-800"
            >
              {actions.isLoading ? (
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

      {/* Reschedule Confirmation (single session fallback) */}
      <AlertDialog
        open={actions.showConfirmReschedule}
        onOpenChange={(open) =>
          !open && actions.setShowConfirmReschedule(false)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-zinc-600" />
              Reschedule {type}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Are you sure you want to reschedule{" "}
                  <strong>&quot;{title}&quot;</strong> with{" "}
                  <strong>{consultant}</strong>?
                </p>
                <p className="text-zinc-600">
                  Your current time slots will be released and the{" "}
                  {type.toLowerCase()} status will revert to{" "}
                  <strong>Pending</strong> until new times are allocated.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actions.isLoading}>
              Keep Current Times
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                actions.setShowConfirmReschedule(false);
                actions.handleReschedule();
              }}
              disabled={actions.isLoading}
              className="bg-zinc-900 hover:bg-zinc-800"
            >
              {actions.isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CalendarClock className="h-4 w-4 mr-2" />
              )}
              Reschedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CancelConfirmationDialog
        isOpen={actions.showCancelDialog}
        onConfirm={actions.handleCancelConfirm}
        onCancel={() => actions.setShowCancelDialog(false)}
        title={title}
        consultant={consultant}
        appointmentType={type}
        isLoading={actions.isLoading}
      />
    </motion.div>
  );
}
