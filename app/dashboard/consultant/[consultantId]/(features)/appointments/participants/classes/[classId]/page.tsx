"use client";

import * as Sentry from "@sentry/nextjs";
import React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { ClassEvent } from "../../../types/event";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import type { WaitlistParticipant } from "@/types/participants";

interface ClassParticipantsData {
  classEvent: ClassEvent;
  waitlist: WaitlistParticipant[];
}

// Registered-participant rows are flattened from the class event's slot users.
type RegisteredParticipant = { id: string; name?: string; email?: string };

// Waitlist status pill colors — semantic, kept with dark: variants.
function getWaitlistStatusColor(status: string): string {
  if (status === "NOTIFIED")
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (status === "EXPIRED")
    return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  return "bg-muted text-muted-foreground";
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
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
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

  const { classEvent, waitlist = [] } = data;

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

  const registeredColumns: ResponsiveColumn<RegisteredParticipant>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (participant) => participant.name,
    },
    {
      key: "email",
      header: "Email",
      cell: (participant) => participant.email,
    },
    {
      key: "status",
      header: "Status",
      cell: () => (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
          Registered
        </span>
      ),
    },
  ];

  const renderRegisteredActions = (participant: RegisteredParticipant) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => handleRemoveParticipant(participant.id)}
      disabled={removeParticipantMutation.isPending}
    >
      {removeParticipantMutation.isPending ? "Removing..." : "Remove"}
    </Button>
  );

  const waitlistColumns: ResponsiveColumn<WaitlistParticipant>[] = [
    {
      key: "position",
      header: "Position",
      cell: (entry) => (
        <Badge variant="outline" className="font-mono">
          #{entry.position ?? "-"}
        </Badge>
      ),
    },
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (entry) => entry.user.name,
    },
    {
      key: "email",
      header: "Email",
      cell: (entry) => entry.user.email,
    },
    {
      key: "joined",
      header: "Joined",
      cell: (entry) => format(new Date(entry.joinedAt), "MMM d, yyyy h:mm a"),
    },
    {
      key: "status",
      header: "Status",
      cell: (entry) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getWaitlistStatusColor(
            entry.status,
          )}`}
        >
          {entry.status}
        </span>
      ),
    },
  ];

  const registeredEmpty = (
    <div className="py-8 text-center text-muted-foreground">
      No registered participants yet.
    </div>
  );

  const waitlistEmpty = (
    <div className="py-8 text-center text-muted-foreground">
      Waitlist is empty.
    </div>
  );

  return (
    <>
      <DashboardHeader
        title={`${classEvent.classPlan.title} — Participants`}
        subtitle={`${participants.length}/${classEvent.classPlan.maxParticipants} participants · ${waitlist.length} on waitlist`}
        actions={
          <Link
            href={`/dashboard/consultant/${params.consultantId}/appointments`}
            passHref
          >
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Appointments
            </Button>
          </Link>
        }
      />
      <Card className="mt-6">
        <CardContent className="pt-6">
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
              <ResponsiveTable<RegisteredParticipant>
                columns={registeredColumns}
                rows={participants}
                getRowId={(p) => p.id}
                rowActions={renderRegisteredActions}
                empty={registeredEmpty}
              />
            </TabsContent>

            <TabsContent value="waitlist">
              <ResponsiveTable<WaitlistParticipant>
                columns={waitlistColumns}
                rows={waitlist}
                getRowId={(e) => e.id}
                empty={waitlistEmpty}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </>
  );
}
