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
import { ClassEvent } from "../../../types/event";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface ClassParticipantsData {
  classEvent: ClassEvent;
}

// Fetcher function for class participants
const fetchClassParticipants = async (
  classId: string,
): Promise<ClassParticipantsData> => {
  const response = await fetch(`/api/participants/class/${classId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch class data");
  }
  return response.json();
};

// Fetcher function for removing a participant
const removeClassParticipant = async ({
  classId,
  userId,
}: {
  classId: string;
  userId: string;
}) => {
  const response = await fetch(
    `/api/participants/class/${classId}?userId=${userId}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    throw new Error("Failed to remove participant");
  }

  return response.json();
};

export default function ClassParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const classId = params.classId as string;

  const { data, isLoading, error } = useQuery({
    queryKey: ["class-participants", classId],
    queryFn: () => fetchClassParticipants(classId),
    enabled: !!classId,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeClassParticipant,
    onSuccess: () => {
      // Invalidate and refetch the class participants data
      queryClient.invalidateQueries({
        queryKey: ["class-participants", classId],
      });
    },
    onError: (error) => {
      console.error("Error removing participant:", error);
    },
  });

  const handleRemoveParticipant = (userId: string) => {
    removeParticipantMutation.mutate({ classId, userId });
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error loading class data</div>;
  }

  if (!data?.classEvent) {
    return <div>Class not found</div>;
  }

  const { classEvent } = data;

  // Get unique participants by user ID
  const participants = Array.from(
    new Map(
      (classEvent.appointments || [])
        .flatMap(
          (appointment) =>
            (appointment.slotsOfAppointment || []).flatMap(
              (slot) => slot.user || [],
            ) || [],
        )
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
              {classEvent.classPlan.title} - Participants
            </CardTitle>
            <p className="text-sm text-gray-500">
              {participants.length}/{classEvent.classPlan.maxParticipants}{" "}
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
