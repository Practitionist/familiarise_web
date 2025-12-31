"use client";

import { cn } from "@/utils/tailwind";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { Calendar, Clock, Video, Users, ArrowRight } from "lucide-react";

interface AppointmentCardProps {
  userName: string;
  userImage?: string;
  appointmentType: string;
  planName?: string;
  startTime: string;
  status: "upcoming" | "in-progress" | "completed" | "cancelled" | "joinable";
  isRecurring?: boolean;
  sessionInfo?: {
    completed: number;
    total: number;
  };
  onJoin?: () => void;
  onClick?: () => void;
  className?: string;
}

export function AppointmentCard({
  userName,
  userImage,
  appointmentType,
  planName,
  startTime,
  status,
  isRecurring = false,
  sessionInfo,
  onJoin,
  onClick,
  className,
}: AppointmentCardProps) {
  const statusConfig = {
    upcoming: {
      label: "Upcoming",
      bg: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
    },
    "in-progress": {
      label: "In Progress",
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      border: "border-emerald-200",
    },
    completed: {
      label: "Completed",
      bg: "bg-zinc-100",
      text: "text-zinc-600",
      border: "border-zinc-200",
    },
    cancelled: {
      label: "Cancelled",
      bg: "bg-red-50",
      text: "text-red-700",
      border: "border-red-200",
    },
    joinable: {
      label: "Join Now",
      bg: "bg-green-50",
      text: "text-green-700",
      border: "border-green-300",
    },
  };

  const s = statusConfig[status];

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <motion.div
      whileHover={{ scale: 1.01, y: -1 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-zinc-200/80 bg-white p-4 transition-all hover:shadow-lg hover:shadow-zinc-200/50",
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <Avatar className="h-12 w-12 ring-2 ring-zinc-100">
          <AvatarImage src={userImage} alt={userName} />
          <AvatarFallback className="bg-zinc-100 text-zinc-600 font-medium">
            {initials}
          </AvatarFallback>
        </Avatar>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-zinc-900 truncate">
                {userName}
              </h3>
              <p className="text-sm text-zinc-500 truncate">
                {appointmentType}
                {planName && ` • ${planName}`}
              </p>
            </div>
            <Badge
              variant="outline"
              className={cn("shrink-0", s.bg, s.text, s.border)}
            >
              {s.label}
            </Badge>
          </div>

          {/* Time & Meta */}
          <div className="mt-3 flex items-center gap-4 text-sm text-zinc-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              {startTime}
            </span>
            {isRecurring && sessionInfo && (
              <span className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" />
                {sessionInfo.completed}/{sessionInfo.total} sessions
              </span>
            )}
          </div>

          {/* Progress bar for recurring */}
          {isRecurring && sessionInfo && (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{
                    width: `${(sessionInfo.completed / sessionInfo.total) * 100}%`,
                  }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-blue-500"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Join button for joinable appointments */}
      {status === "joinable" && onJoin && (
        <div className="mt-4 pt-4 border-t border-zinc-100">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            className="w-full bg-zinc-900 hover:bg-zinc-800 text-white gap-2"
          >
            <Video className="h-4 w-4" />
            Join Meeting
          </Button>
        </div>
      )}

      {/* Hover arrow */}
      {onClick && (
        <ArrowRight className="absolute right-4 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-300 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-1" />
      )}
    </motion.div>
  );
}

export function AppointmentCardSkeleton() {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white p-4">
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 animate-pulse rounded-full bg-zinc-200" />
        <div className="flex-1 space-y-3">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <div className="h-5 w-32 animate-pulse rounded bg-zinc-200" />
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
            </div>
            <div className="h-6 w-20 animate-pulse rounded-full bg-zinc-200" />
          </div>
          <div className="flex gap-4">
            <div className="h-4 w-28 animate-pulse rounded bg-zinc-200" />
            <div className="h-4 w-20 animate-pulse rounded bg-zinc-200" />
          </div>
        </div>
      </div>
    </div>
  );
}
