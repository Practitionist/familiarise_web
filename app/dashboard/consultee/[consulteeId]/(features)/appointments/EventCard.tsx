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
    .toLowerCase(); // Convert to lowercase for consistent am/pm
}

export function EventCard({
  title,
  consultant,
  date,
  status,
  image,
  actualSlots,
  type,
  isTentative,
  appointmentId,
  className,
}: Readonly<EventCardProps>) {
  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase();
    if (statusLower === "completed")
      return "bg-green-50 text-green-700 border-green-200";
    if (statusLower === "rejected" || statusLower === "expired")
      return "bg-red-50 text-red-700 border-red-200";
    if (statusLower === "pending")
      return "bg-yellow-50 text-yellow-700 border-yellow-200";
    if (statusLower === "approved")
      return "bg-blue-50 text-blue-700 border-blue-200";
    return "bg-gray-50 text-gray-700 border-gray-200";
  };

  const { toast } = useToast();
  const [isLoading, setIsLoading] = React.useState(false);

  const handleReschedule = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!appointmentId) return;

    try {
      setIsLoading(true);
      const response = await fetch(
        `/api/appointments/${appointmentId}/reschedule`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to request reschedule");
      }

      toast({
        title: "Reschedule requested",
        description: "Your request has been sent to the consultant.",
      });

      // Refresh the page to show updated status
      window.location.reload();
    } catch (error) {
      console.error("Error requesting reschedule:", error);
      toast({
        title: "Error",
        description: "Failed to request reschedule. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!appointmentId) return;

    if (!confirm("Are you sure you want to cancel this appointment?")) {
      return;
    }

    try {
      setIsLoading(true);
      const response = await fetch(
        `/api/appointments/${appointmentId}/cancel`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to cancel appointment");
      }

      toast({
        title: "Appointment cancelled",
        description: "Your appointment has been cancelled successfully.",
      });

      // Refresh the page to show updated status
      window.location.reload();
    } catch (error) {
      console.error("Error cancelling appointment:", error);
      toast({
        title: "Error",
        description: "Failed to cancel appointment. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClick = () => {
    console.log("EventCard clicked:", {
      title,
      consultant,
      date,
      status,
      type,
      actualSlots,
      isTentative,
    });
  };

  const showEditButton =
    isTentative ||
    date.includes("Please select") ||
    date === "No slot assigned";

  const hasSlots = actualSlots && actualSlots.length > 0;
  const showSessionDetails =
    (type === "Subscription" || type === "Class") && hasSlots;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className={`group ${className || ""}`}
    >
      <Card
        onClick={handleClick}
        className="hover:shadow-md transition-shadow duration-200 border border-gray-100 cursor-pointer w-96 min-h-[16rem] h-auto flex flex-col flex-shrink-0"
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-lg font-semibold break-words">
                {title}
              </CardTitle>
              <div className="flex items-center mt-2">
                <Avatar className="h-6 w-6 mr-2">
                  <AvatarImage
                    src={image ?? "/placeholder.svg"}
                    alt={consultant}
                  />
                  <AvatarFallback>{consultant.charAt(0)}</AvatarFallback>
                </Avatar>
                <span
                  data-testid="consultant-name"
                  className="text-sm text-gray-600 break-words"
                >
                  {consultant}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              {status && (
                <Badge
                  data-testid="event-status"
                  className={`${getStatusColor(status)} whitespace-normal break-words`}
                >
                  {status}
                </Badge>
              )}
              {isTentative && (
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    data-testid="tentative-notice"
                    className="bg-red-50 text-red-700 border-red-200 whitespace-normal break-words"
                  >
                    Tentative
                  </Badge>
                  <span className="text-xs text-red-500">
                    Subject to change
                  </span>
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-grow flex flex-col justify-between">
          <div className="flex flex-col space-y-2">
            {type === "Consultation" || type === "Webinar" ? (
              <div className="flex items-center justify-between">
                <span
                  data-testid="slot-time"
                  className="text-sm text-gray-600 break-words"
                >
                  {actualSlots && actualSlots.length > 0 ? (
                    <div className="bg-gray-50 p-2 rounded flex flex-col space-y-1">
                      <div className="text-sm font-medium text-gray-700 break-words">
                        Scheduled Time
                      </div>
                      <div>
                        <span className="text-sm text-gray-600 break-words">
                          {formatSlotDate(actualSlots[0].startTime)}
                        </span>
                        <span className="text-sm text-gray-600 ml-2 break-words">
                          {formatSlotTime(actualSlots[0].startTime)} -{" "}
                          {formatSlotTime(actualSlots[0].endTime)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-yellow-50 p-2 rounded text-yellow-700 break-words">
                      {date}
                    </div>
                  )}
                </span>
              </div>
            ) : showSessionDetails ? (
              <Accordion type="single" collapsible>
                <AccordionItem value="sessions" className="border-none">
                  <AccordionTrigger className="py-2 hover:no-underline">
                    <span className="text-sm font-medium text-gray-700 break-words">
                      {type === "Subscription"
                        ? "Scheduled Sessions"
                        : "Class Schedule"}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div data-testid="slot-list" className="space-y-2">
                      {actualSlots.map((slot, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between bg-gray-50 p-2 rounded"
                        >
                          <span className="text-sm text-gray-600 break-words">
                            {formatSlotDate(slot.startTime)}
                          </span>
                          <span className="text-sm text-gray-600 break-words">
                            {formatSlotTime(slot.startTime)} -{" "}
                            {formatSlotTime(slot.endTime)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            ) : (
              <div className="flex items-center justify-between">
                <span
                  data-testid="slot-time"
                  className="text-sm text-gray-600 break-words"
                >
                  {date}
                </span>
              </div>
            )}
            <div className="flex justify-end gap-2 mt-auto pt-2">
              {!isTentative && status?.toLowerCase() !== "cancelled" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReschedule}
                  disabled={isLoading}
                  className="flex items-center gap-1 text-yellow-600 hover:text-yellow-700 hover:bg-yellow-50"
                >
                  <ClockIcon className="h-4 w-4" />
                  Request Reschedule
                </Button>
              )}
              {status?.toLowerCase() !== "cancelled" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  disabled={isLoading}
                  className="flex items-center gap-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <XIcon className="h-4 w-4" />
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
