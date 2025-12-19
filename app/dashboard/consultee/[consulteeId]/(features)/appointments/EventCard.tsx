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
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { Clock, X, Upload, Video, Calendar, ChevronDown } from "lucide-react";
import React from "react";
import { DocumentUpload } from "./DocumentUpload";
import { cn } from "@/utils/tailwind";
import { format } from "date-fns";

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
  type?: "Subscription" | "Class" | "Consultation" | "Webinar";
  isTentative?: boolean;
  appointmentId?: string;
  className?: string;
}

function formatSlotDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "EEE, d MMM yyyy");
}

function formatSlotTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(d, "h:mm a");
}

// Status configuration - refined professional colors
const statusConfig: Record<string, { bg: string; text: string; dot: string }> = {
  APPROVED: { bg: "bg-teal-50", text: "text-teal-600", dot: "bg-teal-500" },              // Teal - sophisticated success
  PENDING: { bg: "bg-orange-50", text: "text-orange-600", dot: "bg-orange-500" },         // Orange - warm urgency
  SCHEDULED: { bg: "bg-indigo-50", text: "text-indigo-600", dot: "bg-indigo-500" },       // Indigo - elegant upcoming
  IN_PROGRESS: { bg: "bg-cyan-50", text: "text-cyan-600", dot: "bg-cyan-500" },           // Cyan - bright active
  COMPLETED: { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-400" },         // Slate - warm done
  CANCELLED: { bg: "bg-stone-100", text: "text-stone-400", dot: "bg-stone-400" },         // Stone - neutral inactive
  REJECTED: { bg: "bg-red-50", text: "text-red-600", dot: "bg-red-500" },                 // Red - clear negative
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
}: Readonly<EventCardProps>) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = React.useState(false);

  const showSessionDetails =
    (type === "Subscription" || type === "Class") &&
    actualSlots &&
    actualSlots.length > 1;

  const handleReschedule = async () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/reschedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to request reschedule");
      }

      toast({
        title: "Reschedule request sent",
        description: `Your reschedule request for ${title} has been sent to ${consultant}.`,
      });

      window.location.reload();
    } catch (error) {
      console.error("Error requesting reschedule:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to request reschedule",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }

    if (
      !window.confirm(
        `Are you sure you want to cancel "${title}" with ${consultant}? This action cannot be undone.`,
      )
    ) {
      return;
    }

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

      window.location.reload();
    } catch (error) {
      console.error("Error cancelling appointment:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to cancel appointment",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const isConfirmed =
    status?.toLowerCase() === "approved" ||
    status?.toLowerCase() === "scheduled" ||
    (!isTentative && actualSlots.length > 0);

  const showDocumentUpload =
    (type === "Consultation" || type === "Subscription") &&
    appointmentId &&
    isConfirmed;

  const statusStyle = statusConfig[status?.toUpperCase()] || statusConfig.PENDING;
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
              {consultant?.split(" ").slice(0, 2).map((name) => name[0]).join("")}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-zinc-900 text-sm leading-tight line-clamp-2 mb-1" title={title}>
              {title}
            </h3>
            <p className="text-xs text-zinc-500 line-clamp-1" title={consultant}>
              {consultant}
            </p>
          </div>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2 mb-4">
          <Badge className="text-[10px] font-medium px-2 py-0.5 bg-transparent border border-zinc-300 text-zinc-600 rounded-md">
            {type}
          </Badge>
          <Badge className={cn("text-[10px] font-semibold px-2 py-0.5 border-0 flex items-center gap-1", displayStatusStyle.bg, displayStatusStyle.text)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", displayStatusStyle.dot)} />
            {displayStatus?.replace(/_/g, " ")}
          </Badge>
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
                {formatSlotTime(actualSlots[0].startTime)} - {formatSlotTime(actualSlots[0].endTime)}
              </div>
            </div>
          ) : showSessionDetails ? (
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="sessions" className="border border-zinc-100 rounded-lg overflow-hidden">
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
                          {formatSlotTime(slot.startTime)} - {formatSlotTime(slot.endTime)}
                        </span>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : type !== "Consultation" && type !== "Webinar" ? (
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                <Clock className="h-3.5 w-3.5" />
                <span>Next Session</span>
              </div>
              <div className="text-sm text-zinc-700">{date}</div>
            </div>
          ) : null}
        </div>

        {/* Document Upload */}
        {showDocumentUpload && (
          <div className="mt-4 pt-4 border-t border-zinc-100">
            <DocumentUpload
              appointmentId={appointmentId}
              appointmentTitle={title}
              appointmentType={type}
            />
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-zinc-100">
          {!isTentative && status?.toLowerCase() !== "cancelled" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReschedule}
              disabled={isLoading}
              className="flex-1 h-8 text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50 border-zinc-200"
            >
              <Clock className="h-3.5 w-3.5 mr-1.5" />
              Reschedule
            </Button>
          )}
          {status?.toLowerCase() !== "cancelled" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={isLoading}
              className="flex-1 h-8 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 hover:border-red-300"
            >
              <X className="h-3.5 w-3.5 mr-1.5" />
              Cancel
            </Button>
          )}
        </div>

        {/* Join Button for confirmed appointments */}
        {isConfirmed && status?.toLowerCase() !== "cancelled" && (
          <Button
            className="w-full mt-3 h-9 bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-sm"
          >
            <Video className="h-4 w-4 mr-2" />
            Join Session
          </Button>
        )}
      </div>
    </motion.div>
  );
}
