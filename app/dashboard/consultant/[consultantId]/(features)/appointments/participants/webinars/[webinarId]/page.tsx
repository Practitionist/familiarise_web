"use client";

import React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WebinarEvent } from "../../../types/event";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import type { WaitlistParticipant } from "@/types/participants";

interface WebinarParticipantsData {
  webinarEvent: WebinarEvent;
  waitlist: WaitlistParticipant[];
}

// Fetcher function for webinar participants
const fetchWebinarParticipants = async (
  webinarId: string,
): Promise<WebinarParticipantsData> => {
  const response = await fetch(`/api/participants/webinar/${webinarId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch webinar data");
  }
  return response.json();
};

// Fetcher function for removing a participant
const removeWebinarParticipant = async ({
  webinarId,
  userId,
}: {
  webinarId: string;
  userId: string;
}) => {
  const response = await fetch(
    `/api/participants/webinar/${webinarId}?userId=${userId}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    throw new Error("Failed to remove participant");
  }

  return response.json();
};

export default function WebinarParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const webinarId = params.webinarId as string;

  const { data, isLoading, error } = useQuery({
    queryKey: ["webinar-participants", webinarId],
    queryFn: () => fetchWebinarParticipants(webinarId),
    enabled: !!webinarId,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeWebinarParticipant,
    onSuccess: () => {
      // Invalidate and refetch the webinar participants data
      queryClient.invalidateQueries({
        queryKey: ["webinar-participants", webinarId],
      });
    },
    onError: (error) => {
      console.error("Error removing participant:", error);
    },
  });

  const handleRemoveParticipant = (userId: string) => {
    removeParticipantMutation.mutate({ webinarId, userId });
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error loading webinar data</div>;
  }

  if (!data?.webinarEvent) {
    return <div>Webinar not found</div>;
  }

  const { webinarEvent: webinar, waitlist = [] } = data;

  // Get unique participants by user ID
  const participants = Array.from(
    new Map(
      (webinar.appointment?.slotsOfAppointment || [])
        .flatMap((slot) => slot.user || [])
        .map((user) => [user.id, user]) || [],
    ).values(),
  );

  return (
    <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <Link
            href={`/dashboard/consultant/${params.consultantId}/appointments`}
            passHref
            className="mb-4"
          >
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Appointments
            </Button>
          </Link>
          <div>
            <CardTitle className="text-2xl font-bold">
              {webinar.webinarPlan.title} - Participants
            </CardTitle>
            <div className="flex gap-4 text-sm text-gray-500 mt-1">
              <span>
                {participants.length}/{webinar.webinarPlan.maxParticipants}{" "}
                registered
              </span>
              <span>•</span>
              <span>{waitlist.length} on waitlist</span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="registered" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="registered">Registered</TabsTrigger>
              <TabsTrigger value="waitlist">
                Waitlist
                {waitlist.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-2 h-5 px-1.5 min-w-5"
                  >
                    {waitlist.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="registered">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {participants.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center h-24">
                        No registered participants yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    participants.map((participant) => (
                      <TableRow key={participant.id}>
                        <TableCell>{participant.name}</TableCell>
                        <TableCell>{participant.email}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            Registered
                          </span>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              handleRemoveParticipant(participant.id)
                            }
                            disabled={removeParticipantMutation.isPending}
                          >
                            {removeParticipantMutation.isPending
                              ? "Removing..."
                              : "Remove"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="waitlist">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Position</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {waitlist.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center h-24">
                        Waitlist is empty.
                      </TableCell>
                    </TableRow>
                  ) : (
                    waitlist.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono">
                            #{entry.position ?? "-"}
                          </Badge>
                        </TableCell>
                        <TableCell>{entry.user.name}</TableCell>
                        <TableCell>{entry.user.email}</TableCell>
                        <TableCell>
                          {format(
                            new Date(entry.joinedAt),
                            "MMM d, yyyy h:mm a",
                          )}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              entry.status === "NOTIFIED"
                                ? "bg-amber-100 text-amber-800"
                                : entry.status === "EXPIRED"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-gray-100 text-gray-800"
                            }`}
                          >
                            {entry.status}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
