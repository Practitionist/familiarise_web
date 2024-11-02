import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface Activity {
  id: string;
  name: string;
  action: string;
  time: string;
}

interface ClientActivityProps {
  activities: Activity[];
}

export const ClientActivity: React.FC<ClientActivityProps> = ({
  activities,
}) => (
  <div className="space-y-4">
    {activities.map((activity) => (
      <div key={activity.id} className="flex items-center justify-between">
        <div className="flex items-center">
          <Avatar>
            <AvatarImage alt={activity.name} src="/placeholder.svg" />
            <AvatarFallback>{activity.name[0]}</AvatarFallback>
          </Avatar>
          <p className="ml-2">{activity.action}</p>
        </div>
        <p className="text-sm text-gray-500">{activity.time}</p>
      </div>
    ))}
  </div>
);
