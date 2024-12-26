"use client";

import React from "react";
import { motion } from "framer-motion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
}

export function EventCard({
  title,
  consultant,
  date,
  status,
  image,
  slots,
  type,
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="group h-full"
    >
      <Card className="hover:shadow-md transition-shadow duration-200 border border-gray-100 h-full">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-lg font-semibold">{title}</CardTitle>
              <div className="flex items-center mt-2">
                <Avatar className="h-6 w-6 mr-2">
                  <AvatarImage
                    src={image || "/placeholder.svg"}
                    alt={consultant}
                  />
                  <AvatarFallback>{consultant.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="text-sm text-gray-600">{consultant}</span>
              </div>
            </div>
            {status && (
              <Badge className={`ml-2 ${getStatusColor(status)}`}>
                {status}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col space-y-2">
            {slots ? (
              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-700">
                  {type === "Subscription" ? "Scheduled Sessions" : "Session Times"}:
                </div>
                {slots.map((slot, index) => (
                  <div key={index} className="flex items-center justify-between bg-gray-50 p-2 rounded">
                    <span className="text-sm text-gray-600">
                      {new Date(slot.startTime).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric'
                      })}
                    </span>
                    <span className="text-sm font-medium text-gray-700">
                      {new Date(slot.startTime).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                      })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{date}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
