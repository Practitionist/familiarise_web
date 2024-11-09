import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ClientActivityProps } from "../types";

export function ClientActivity({ activities }: Readonly<ClientActivityProps>) {
  return (
    <div className="space-y-4">
      {activities.map((activity) => (
        <div key={activity.id} className="flex items-center space-x-4">
          <Avatar className="h-8 w-8">
            <AvatarImage alt={activity.name} src="/placeholder.svg" />
            <AvatarFallback>
              {activity.name
                .split(" ")
                .map((n) => n[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="flex-grow">
            <p className="text-sm">
              <span className="font-semibold">{activity.name}</span>{" "}
              <span className="text-gray-600">{activity.action}</span>
            </p>
            <p className="text-xs text-gray-500">{activity.time}</p>
          </div>
        </div>
      ))}
      {activities.length === 0 && (
        <p className="text-gray-500 text-center">No recent activity</p>
      )}
    </div>
  );
}
