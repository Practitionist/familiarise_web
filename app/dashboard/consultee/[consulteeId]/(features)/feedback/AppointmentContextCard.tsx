"use client";

import React from "react";
import { Calendar, User, Clock, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AppointmentContextData {
  appointmentId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION";
  appointmentStatus: "COMPLETED" | "UPCOMING";
  consultantName?: string;
  scheduledAt?: string;
}

interface AppointmentContextCardProps {
  context: AppointmentContextData;
  onClear?: () => void;
  className?: string;
}

/**
 * Displays linked appointment context when creating a support ticket
 * from an appointment card
 */
export function AppointmentContextCard({
  context,
  onClear,
  className,
}: AppointmentContextCardProps) {
  const { appointmentType, appointmentStatus, consultantName, scheduledAt } =
    context;

  const formatDate = (dateString?: string) => {
    if (!dateString) return null;
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  };

  const typeLabel =
    appointmentType === "CONSULTATION" ? "Consultation" : "Subscription";
  const statusLabel =
    appointmentStatus === "COMPLETED" ? "Completed" : "Upcoming";
  const statusColor =
    appointmentStatus === "COMPLETED"
      ? "bg-green-50 text-green-700 border-green-200"
      : "bg-blue-50 text-blue-700 border-blue-200";

  return (
    <div
      className={cn(
        "p-4 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200",
        "dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-amber-100 dark:bg-amber-800/50">
            <Link2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
            Linked to {typeLabel}
          </span>
        </div>
        {onClear && (
          <button
            onClick={onClear}
            className="text-xs text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 underline"
          >
            Clear link
          </button>
        )}
      </div>

      {/* Context Details */}
      <div className="space-y-2">
        {consultantName && (
          <div className="flex items-center gap-2 text-sm">
            <User className="h-4 w-4 text-zinc-400" />
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              {consultantName}
            </span>
          </div>
        )}

        {scheduledAt && (
          <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Calendar className="h-4 w-4 text-zinc-400" />
            <span>{formatDate(scheduledAt)}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-zinc-400" />
          <span
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
              statusColor,
            )}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Helper Text */}
      <p className="mt-3 text-xs text-amber-700/80 dark:text-amber-400/80">
        Your support ticket will be linked to this {typeLabel.toLowerCase()} for
        faster resolution.
      </p>
    </div>
  );
}
