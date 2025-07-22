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
    setIsLoading(true);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1000));
    toast({
      title: "Reschedule request sent",
      description: `Your reschedule request for ${title} has been sent to ${consultant}.`,
      duration: 3000,
    });
    setIsLoading(false);
  };

  const handleCancel = async () => {
    if (
      !window.confirm(
        `Are you sure you want to cancel "${title}" with ${consultant}?`,
      )
    ) {
      return;
    }

    setIsLoading(true);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1000));
    toast({
      title: "Appointment cancelled",
      description: `Your ${type.toLowerCase()} "${title}" has been cancelled.`,
      variant: "destructive",
      duration: 3000,
    });
    setIsLoading(false);
  };

  // Determine if appointment is confirmed and scheduled
  const isConfirmed = status?.toLowerCase() === "approved" || 
                     status?.toLowerCase() === "scheduled" ||
                     (!isTentative && actualSlots.length > 0);

  // Show document upload for consultations and subscriptions only
  const showDocumentUpload = (type === "Consultation" || type === "Subscription") && 
                             appointmentId && 
                             isConfirmed;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.2 }}
      className={`${className}`}
    >
      <Card className="w-64 flex-shrink-0 transition-all duration-200 hover:shadow-md">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Avatar className="w-8 h-8">
                <AvatarImage alt={consultant} src={image || undefined} />
                <AvatarFallback className="text-xs">
                  {consultant
                    ?.split(" ")
                    .slice(0, 2)
                    .map((name) => name[0])
                    .join("")}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <CardTitle
                  className="text-sm leading-tight truncate max-w-full break-words"
                  data-testid="card-title"
                >
                  {title}
                </CardTitle>
                <p className="text-xs text-gray-600 truncate max-w-full break-words">
                  {consultant}
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge
                variant={
                  isTentative
                    ? "outline"
                    : status?.toLowerCase() === "cancelled"
                      ? "destructive"
                      : "default"
                }
                className="text-xs px-2 py-0.5"
              >
                {isTentative
                  ? "Pending"
                  : status?.replace(/([A-Z])/g, " $1").trim() || "Active"}
              </Badge>
              <Badge variant="secondary" className="text-xs px-2 py-0.5">
                {type}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-col h-full gap-2">
            {type === "Class" && actualSlots.length === 1 ? (
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
                          <div className="flex flex-col">
                            <span className="text-sm text-gray-600 break-words">
                              {formatSlotDate(slot.startTime)}
                            </span>
                          </div>
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
            <div className="flex flex-col gap-2 mt-auto pt-2">
              {/* Document Upload Section */}
              {showDocumentUpload && (
                <div className="border-t pt-2">
                  <DocumentUpload
                    appointmentId={appointmentId}
                    appointmentTitle={title}
                    appointmentType={type}
                  />
                </div>
              )}
              
              {/* Action Buttons */}
              <div className="flex justify-end gap-2">
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
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
