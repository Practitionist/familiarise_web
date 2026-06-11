"use client";

import React from "react";
import { Button } from "@/components/ui/button";
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
import { motion } from "framer-motion";
import {
  Clock,
  Calendar,
  CalendarClock,
  Loader2,
  CreditCard,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/utils/tailwind";
import type { TAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";
import type { BookingStatus } from "@/components/ui/waitlist-status-badge";

import { CardHeader } from "./CardHeader";
import { StatusBadgeGroup } from "./StatusBadgeGroup";
import { CountdownBadge } from "./CountdownBadge";
import { JoinButton } from "./JoinButton";
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

interface OneOffEventCardProps {
  title: string;
  consultant: string;
  image?: string | null;
  status: string;
  type: "Consultation" | "Webinar" | "Trial";
  isTentative: boolean;
  appointmentId?: string;
  appointment?: TAppointment;
  rawSlots: SlotOfAppointment[];
  pendingPaymentUrl?: string | null;
  bookingStatus?: BookingStatus;
  waitlistPosition?: number;
  collaborators?: CollaboratorInfo[];
}

function formatSlotDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "EEE, d MMM");
}

function formatSlotTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "h:mm a");
}

export function OneOffEventCard({
  title,
  consultant,
  image,
  status,
  type,
  isTentative,
  appointmentId,
  appointment,
  rawSlots,
  pendingPaymentUrl,
  bookingStatus,
  waitlistPosition,
  collaborators = [],
}: OneOffEventCardProps) {
  const actions = useEventActions({
    appointmentId,
    appointment,
    rawSlots,
    title,
    consultant,
    type,
  });

  const isInactive =
    status?.toLowerCase() === "cancelled" ||
    status?.toLowerCase() === "rejected" ||
    status?.toLowerCase() === "completed" ||
    status?.toLowerCase() === "expired";

  const isPendingPayment = status?.toUpperCase() === "APPROVED_PENDING_PAYMENT";
  const isApproved = status?.toUpperCase() === "APPROVED";
  const isDev = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";
  const canDevJoin = isDev && rawSlots.length > 0 && !!appointment;

  const isConfirmed = ["APPROVED", "SCHEDULED", "IN_PROGRESS"].includes(
    status?.toUpperCase(),
  );
  const showDocUpload =
    (type === "Consultation" || type === "Trial") &&
    !!appointmentId &&
    isConfirmed;

  const appointmentStatus: AppointmentStatus =
    status?.toLowerCase() === "completed" ? "COMPLETED" : "UPCOMING";
  const appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" =
    type === "Trial"
      ? "SUBSCRIPTION"
      : type === "Webinar"
        ? "WEBINAR"
        : "CONSULTATION";

  const scheduledAt =
    rawSlots.length > 0
      ? new Date(rawSlots[0].startsAt).toISOString()
      : undefined;

  // First slot for schedule display
  const firstSlot = rawSlots.find((s) => !s.isTentative) ?? rawSlots[0];
  const lastSlot = rawSlots.filter((s) => !s.isTentative).at(-1) ?? firstSlot;

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
            organizationId={appointment?.organizationId}
          />
        </div>

        {/* Schedule section */}
        <div className="flex-1">
          {firstSlot ? (
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{formatSlotDate(firstSlot.startsAt)}</span>
                  </div>
                  <div className="text-sm text-zinc-700 font-medium">
                    {formatSlotTime(firstSlot.startsAt)} —{" "}
                    {formatSlotTime(lastSlot?.endsAt ?? firstSlot.endsAt)}
                  </div>
                </div>
                {!isInactive && !isTentative && (
                  <CountdownBadge
                    targetDate={firstSlot.startsAt}
                    sessionEndDate={lastSlot?.endsAt ?? firstSlot.endsAt}
                  />
                )}
              </div>
            </div>
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
                        ? "No session was scheduled"
                        : "No session scheduled yet"}
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

        {/* Document upload — full width, above action buttons */}
        {showDocUpload && (
          <div className="mt-3 pt-3 border-t border-zinc-100">
            <DocumentUpload
              appointmentId={appointmentId!}
              appointmentTitle={title}
              appointmentType={type}
            />
          </div>
        )}

        {/* Action bar */}
        <div
          className={cn(
            "flex items-center gap-2",
            showDocUpload && !isInactive
              ? "mt-3"
              : "mt-3 pt-3 border-t border-zinc-100",
          )}
        >
          {!isTentative && isApproved && !isInactive ? (
            <>
              <div className="flex-1">
                <JoinButton
                  slot={actions.joinableSlot}
                  isJoining={actions.isJoining}
                  onJoin={() => actions.handleJoinSession()}
                  disabled={isInactive}
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 border-zinc-200"
                onClick={() => actions.handleRescheduleClick(false)}
                disabled={actions.isLoading}
                title="Reschedule"
              >
                <Clock className="h-4 w-4" />
              </Button>
            </>
          ) : !isInactive ? (
            <div className="flex-1 text-xs text-zinc-400 text-center py-2">
              {isTentative
                ? "Awaiting confirmation"
                : isPendingPayment || bookingStatus === "CONFIRMED"
                  ? ""
                  : "Pending approval"}
            </div>
          ) : (
            <div className="flex-1 text-xs text-zinc-400 text-center py-2">
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

      {/* Dialogs */}
      {appointmentId && (
        <ReportIssueDialog
          open={actions.showReportDialog}
          onOpenChange={actions.setShowReportDialog}
          appointmentId={appointmentId}
          appointmentType={appointmentType}
          appointmentStatus={appointmentStatus}
          consultantName={consultant}
          scheduledAt={scheduledAt}
          onSuccess={() => actions.setShowReportDialog(false)}
        />
      )}

      {/* Reschedule Confirmation (non-subscription single session) */}
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
                  Your current time slot will be released and the{" "}
                  {type === "Consultation"
                    ? "consultation"
                    : type?.toLowerCase()}{" "}
                  status will revert to <strong>Pending</strong> until a new
                  time is allocated.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actions.isLoading}>
              Keep Current Time
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
