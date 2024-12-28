"use client";

import React from "react";
import { motion } from "framer-motion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PencilIcon, XIcon } from "lucide-react";

interface EventCardProps {
  title: string;
  consultant: string;
  date: string;
  status?: string;
  image?: string | null;
  slots?: Array<{
    startTime: string;
    endTime?: string;
  }>;
  type?: "Subscription" | "Class" | "Consultation" | "Webinar";
  isTentative?: boolean;
}

export function EventCard({
  title,
  consultant,
  date,
  status,
  image,
  slots,
  type,
  isTentative,
}: Readonly<EventCardProps>) {
  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase();
    if (statusLower === "completed")
      return "bg-green-50 text-green-700 border-green-200";
    if (statusLower === "rejected")
      return "bg-red-50 text-red-700 border-red-200";
    if (statusLower === "pending")
      return "bg-yellow-50 text-yellow-700 border-yellow-200";
    return "bg-gray-50 text-gray-700 border-gray-200";
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log("Edit clicked:", {
      title,
      type,
      status,
      isTentative,
    });
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log("Cancel clicked:", {
      title,
      type,
      status,
      isTentative,
    });
  };

  const handleClick = () => {
    console.log("EventCard clicked:", {
      title,
      consultant,
      date,
      status,
      type,
      slots,
      isTentative,
    });
  };

  const showEditButton =
    isTentative ||
    date.includes("Please select") ||
    date === "No slot assigned";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="group h-full"
    >
      <button onClick={handleClick} className="w-full text-left">
        <Card className="hover:shadow-md transition-shadow duration-200 border border-gray-100 h-full">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg font-semibold">{title}</CardTitle>
                <div className="flex items-center mt-2">
                  <Avatar className="h-6 w-6 mr-2">
                    <AvatarImage
                      src={image ?? "/placeholder.svg"}
                      alt={consultant}
                    />
                    <AvatarFallback>{consultant.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-gray-600">{consultant}</span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {status && (
                  <Badge className={`${getStatusColor(status)}`}>
                    {status}
                  </Badge>
                )}
                {isTentative && (
                  <Badge className="bg-red-50 text-red-700 border-red-200">
                    Tentative
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col space-y-2">
              {slots ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-gray-700">
                    {type === "Subscription"
                      ? "Scheduled Sessions"
                      : "Session Times"}
                    :
                  </div>
                  {slots.map((slot) => (
                    <div
                      key={`${slot.startTime}-${slot.endTime}`}
                      className="flex items-center justify-between bg-gray-50 p-2 rounded"
                    >
                      <span className="text-sm text-gray-600">
                        {new Date(slot.startTime).toLocaleDateString(
                          undefined,
                          {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          },
                        )}
                      </span>
                      <span className="text-sm font-medium text-gray-700">
                        {new Date(slot.startTime).toLocaleTimeString(
                          undefined,
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: true,
                          },
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{date}</span>
                  {isTentative && (
                    <span className="text-xs text-red-500">
                      Subject to change
                    </span>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2 mt-4">
                {showEditButton && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleEdit}
                    className="flex items-center gap-1 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                  >
                    <PencilIcon className="h-4 w-4" />
                    Edit
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  className="flex items-center gap-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <XIcon className="h-4 w-4" />
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </button>
    </motion.div>
  );
}
