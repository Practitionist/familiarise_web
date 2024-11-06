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
    if (badge === 'Completed') {
      return 'bg-gray-400 text-white';
    }
    if (badge.includes('5 min')) {
      return 'bg-red-500 text-white';
    }
    if (badge.includes('2 hours')) {
      return 'bg-blue-500 text-white';
    }
    if (badge === 'Tomorrow') {
      return 'bg-purple-500 text-white';
    }
    if (badge.startsWith('In ')) {
      if (badge.includes('week')) {
        return 'bg-green-500 text-white';
      }
      if (badge.includes('month')) {
        return 'bg-yellow-500 text-white';
      }
      if (badge.includes('year')) {
        return 'bg-orange-500 text-white';
      }
      return 'bg-gray-500 text-white'; // For "In X days"
    }
    return 'bg-gray-400 text-white';
  };

  // Determine if join button should be enabled and its style
  const isJoinable = badge.includes('5 min');
  const joinButtonStyle = isJoinable 
    ? "bg-black text-white hover:bg-gray-800" 
    : "bg-gray-400 text-white cursor-not-allowed";

  // Log props for debugging
  console.log('AppointmentCard props:', {
    name,
    description,
    time,
    badge,
    isJoinable,
    badgeStyle: getBadgeStyle(badge)
  });

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
          className={joinButtonStyle}
          disabled={!isJoinable}
        >
          Join meet
        </Button>
      </CardFooter>
    </Card>
  );
};
