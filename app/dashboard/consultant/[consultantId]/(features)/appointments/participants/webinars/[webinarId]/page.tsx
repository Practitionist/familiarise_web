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

interface WebinarParticipantsData {
  webinarEvent: WebinarEvent;
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

  const { webinarEvent: webinar } = data;

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
            <p className="text-sm text-gray-500">
              {participants.length}/{webinar.webinarPlan.maxParticipants}{" "}
              participants
            </p>
          </div>
        </CardHeader>
        <CardContent>
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
              {participants.map((participant) => (
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
                      onClick={() => handleRemoveParticipant(participant.id)}
                      disabled={removeParticipantMutation.isPending}
                    >
                      {removeParticipantMutation.isPending
                        ? "Removing..."
                        : "Remove"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
