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
import { DashboardHeader } from "@/components/dashboard/DashboardShell";
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

// Registered-participant rows are flattened from the webinar event's slot users.
type RegisteredParticipant = { id: string; name?: string; email?: string };

// Waitlist status pill colors — semantic, kept with dark: variants.
function getWaitlistStatusColor(status: string): string {
  if (status === "NOTIFIED")
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (status === "EXPIRED")
    return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  return "bg-muted text-muted-foreground";
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
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
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
        title={`${webinar.webinarPlan.title} — Participants`}
        subtitle={`${participants.length}/${webinar.webinarPlan.maxParticipants} registered · ${waitlist.length} on waitlist`}
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
