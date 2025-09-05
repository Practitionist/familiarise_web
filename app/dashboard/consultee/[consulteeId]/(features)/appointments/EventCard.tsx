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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { ClockIcon, XIcon } from "lucide-react";
import React from "react";
import { DocumentUpload } from "./DocumentUpload";

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
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatSlotTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d
    .toLocaleString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/\s/, "");
}

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
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to request reschedule");
      }

      toast({
        title: "Reschedule request sent",
        description: `Your reschedule request for ${title} has been sent to ${consultant}.`,
        variant: "default",
      });

      // Optionally refresh the page or update state
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
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to cancel appointment");
      }

      toast({
        title: "Appointment cancelled",
        description: `Your ${type.toLowerCase()} "${title}" has been cancelled successfully.`,
        variant: "default",
      });

      // Refresh the page to reflect the cancellation
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

  // Determine if appointment is confirmed and scheduled
  const isConfirmed =
    status?.toLowerCase() === "approved" ||
    status?.toLowerCase() === "scheduled" ||
    (!isTentative && actualSlots.length > 0);

  // Show document upload for consultations and subscriptions only
  const showDocumentUpload =
    (type === "Consultation" || type === "Subscription") &&
    appointmentId &&
    isConfirmed;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.2 }}
      className={`w-full h-full ${className}`}
    >
      <Card className="w-full h-full min-h-[280px] max-w-none flex flex-col transition-all duration-200 hover:shadow-lg border border-gray-200 bg-white">
        <CardHeader className="pb-3 flex-shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start space-x-3 min-w-0 flex-1">
              <Avatar className="w-10 h-10 flex-shrink-0">
                <AvatarImage alt={consultant} src={image || undefined} />
                <AvatarFallback className="text-sm bg-gray-100 text-gray-700 font-medium">
                  {consultant
                    ?.split(" ")
                    .slice(0, 2)
                    .map((name) => name[0])
                    .join("")}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <CardTitle
                  className="text-sm font-semibold leading-tight text-gray-900 mb-1 line-clamp-2"
                  data-testid="card-title"
                  title={title}
                >
                  {title}
                </CardTitle>
                <p
                  className="text-xs text-gray-600 line-clamp-1"
                  title={consultant}
                >
                  {consultant}
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <Badge
                variant={
                  isTentative
                    ? "outline"
                    : status?.toLowerCase() === "cancelled"
                      ? "destructive"
                      : "default"
                }
                className="text-xs px-2 py-0.5 font-medium whitespace-nowrap"
              >
                {isTentative
                  ? "Pending"
                  : status?.replace(/([A-Z])/g, " $1").trim() || "Active"}
              </Badge>
              <Badge
                variant="secondary"
                className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700"
              >
                {type}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0 flex-1 flex flex-col">
          <div className="flex flex-col h-full gap-3">
            {/* Time/Schedule Section */}
            <div className="flex-shrink-0">
              {type === "Class" && actualSlots.length === 1 ? (
                <div>
                  {actualSlots && actualSlots.length > 0 ? (
                    <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                      <div className="text-sm font-medium text-gray-700 mb-2">
                        Scheduled Time
                      </div>
                      <div className="space-y-1">
                        <div className="text-sm text-gray-600">
                          {formatSlotDate(actualSlots[0].startTime)}
                        </div>
                        <div className="text-sm text-gray-600">
                          {formatSlotTime(actualSlots[0].startTime)} -{" "}
                          {formatSlotTime(actualSlots[0].endTime)}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-200 text-yellow-700 text-sm">
                      {date}
                    </div>
                  )}
                </div>
              ) : showSessionDetails ? (
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="sessions" className="border-none">
                    <AccordionTrigger className="py-2 hover:no-underline text-left">
                      <span className="text-sm font-medium text-gray-700">
                        {type === "Subscription"
                          ? "Scheduled Sessions"
                          : "Class Schedule"}
                      </span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div
                        data-testid="slot-list"
                        className="space-y-2 max-h-32 overflow-y-auto"
                      >
                        {actualSlots.map((slot, index) => (
                          <div
                            key={index}
                            className="flex items-center justify-between bg-gray-50 p-2 rounded border border-gray-100 text-sm"
                          >
                            <div className="text-gray-600 min-w-0 flex-1">
                              {formatSlotDate(slot.startTime)}
                            </div>
                            <div className="text-gray-600 text-xs ml-2 flex-shrink-0">
                              {formatSlotTime(slot.startTime)} -{" "}
                              {formatSlotTime(slot.endTime)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : (
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                  <div className="text-sm text-gray-600">{date}</div>
                </div>
              )}
            </div>

            {/* Content Area - Takes up remaining space */}
            <div className="flex-1 flex flex-col justify-end gap-3">
              {/* Document Upload Section */}
              {showDocumentUpload && (
                <div className="border-t pt-3">
                  <DocumentUpload
                    appointmentId={appointmentId}
                    appointmentTitle={title}
                    appointmentType={type}
                  />
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row justify-end gap-2">
                {!isTentative && status?.toLowerCase() !== "cancelled" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReschedule}
                    disabled={isLoading}
                    className="flex items-center justify-center gap-1 text-yellow-600 hover:text-yellow-700 hover:bg-yellow-50 border-yellow-200 hover:border-yellow-300 transition-colors w-full sm:w-auto"
                  >
                    <ClockIcon className="h-4 w-4" />
                    <span className="text-xs">
                      {isLoading ? "Requesting..." : "Request Reschedule"}
                    </span>
                  </Button>
                )}
                {status?.toLowerCase() !== "cancelled" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancel}
                    disabled={isLoading}
                    className="flex items-center justify-center gap-1 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 hover:border-red-300 transition-colors w-full sm:w-auto"
                  >
                    <XIcon className="h-4 w-4" />
                    <span className="text-xs">
                      {isLoading ? "Cancelling..." : "Cancel"}
                    </span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
