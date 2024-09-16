import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

interface AppointmentCardProps {
  name: string;
  description: string;
  time: string;
  badge: string;
}

export const AppointmentCard: React.FC<AppointmentCardProps> = ({ name, description, time, badge }) => (
  <Card className="bg-purple-100">
    <CardHeader>
      <Avatar>
        <AvatarImage alt={name} src="/placeholder.svg" />
        <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
      </Avatar>
      <div>
        <CardTitle>{name}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </CardHeader>
    <CardContent>
      <p className="text-sm">{time}</p>
    </CardContent>
    <CardFooter className="flex justify-between">
      <Badge variant="secondary" className="bg-blue-500 text-white">{badge}</Badge>
      <Button variant="default" className="bg-black text-white">Join meet</Button>
    </CardFooter>
  </Card>
);