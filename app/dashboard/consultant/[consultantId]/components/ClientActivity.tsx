import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ClientActivityProps } from "../types";

export function ClientActivity({ activities }: Readonly<ClientActivityProps>) {
  return (
    <div className="space-y-3 sm:space-y-4">
      {activities.map((activity) => (
        <div
          key={activity.id}
          className="flex items-start sm:items-center gap-2 sm:gap-4 p-2 hover:bg-purple-50 rounded-lg transition-colors"
        >
          <Avatar className="h-7 w-7 sm:h-8 sm:w-8 flex-shrink-0">
            <AvatarImage alt={activity.name} src="/placeholder.svg" />
            <AvatarFallback className="text-xs sm:text-sm">
              {activity.name
                .split(" ")
                .map((n) => n[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="flex-grow min-w-0">
            <p className="text-xs sm:text-sm leading-snug">
              <span className="font-semibold truncate inline-block max-w-[150px] align-bottom">
                {activity.name}
              </span>{" "}
              <span className="text-gray-600 break-words">
                {activity.action}
              </span>
            </p>
            <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">
              {activity.time}
            </p>
          </div>
        </div>
      ))}
      {activities.length === 0 && (
        <p className="text-xs sm:text-sm text-gray-500 text-center py-4">
          No recent activity
        </p>
      )}
    </div>
  );
}
