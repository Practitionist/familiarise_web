import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AppointmentCardProps {
  name: string;
  description: string;
  time: string;
  badge: string;
}

export const AppointmentCard: React.FC<AppointmentCardProps> = ({
  name,
  description,
  time,
  badge,
}) => {
  // Get initials for avatar fallback
  const initials = name
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase();

  // Determine badge style based on timing
  const getBadgeStyle = (badge: string) => {
    if (badge.includes('5 min')) return 'bg-red-500 text-white';
    if (badge.includes('2 hours')) return 'bg-blue-500 text-white';
    if (badge.includes('Tomorrow')) return 'bg-gray-500 text-white';
    if (badge.includes('Next Week')) return 'bg-gray-500 text-white';
    return 'bg-gray-400 text-white';
  };

  // Determine if join button should be enabled and its style
  const isJoinable = badge.includes('5 min');

  return (
    <Card className="bg-purple-100">
      <CardHeader>
        <div className="flex items-center space-x-4">
          <Avatar>
            <AvatarImage alt={name} src="/placeholder.svg" />
            <AvatarFallback>{initials || '?'}</AvatarFallback>
          </Avatar>
          <div>
            <CardTitle className="text-base font-medium">{name}</CardTitle>
            <CardDescription className="text-sm text-gray-600">
              {description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm font-medium text-gray-700">{time}</p>
      </CardContent>
      <CardFooter className="flex justify-between items-center">
        {badge === 'Schedule unavailable' ? (
          <Badge 
            variant="secondary" 
            className="bg-gray-400 text-white"
          >
            Schedule unavailable
          </Badge>
        ) : (
          <Badge 
            variant="secondary" 
            className={getBadgeStyle(badge)}
          >
            {badge}
          </Badge>
        )}
        <Button 
          variant="default" 
          className={isJoinable ? "bg-black text-white" : "bg-gray-400 text-white"}
          disabled={!isJoinable}
        >
          Join meet
        </Button>
      </CardFooter>
    </Card>
  );
};
