"use client";

import * as Sentry from "@sentry/nextjs";
import React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { PageHeader } from "@/components/ui/page-header";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ParticipantUser } from "@/types/participants";

interface ConsultationParticipantsData {
  consultation: {
    id: string;
    consultationPlan: { id: string; title: string };
  };
  participants: ParticipantUser[];
}

// Fetcher function for consultation participants
const fetchConsultationParticipants = async (
  consultationId: string,
): Promise<ConsultationParticipantsData> => {
  const response = await fetch(
    `/api/participants/consultations/${consultationId}`,
  );
  if (!response.ok) {
    throw new Error("Failed to fetch consultation data");
  }
  return response.json();
};

// Fetcher function for removing a participant
const removeConsultationParticipant = async ({
  consultationId,
  userId,
}: {
  consultationId: string;
  userId: string;
}) => {
  const response = await fetch(
    `/api/participants/consultations/${consultationId}?userId=${userId}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    throw new Error("Failed to remove participant");
  }

  return response.json();
};

export default function ConsultationParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const consultationId = params.consultationId as string;

  const { data, isLoading, error } = useQuery({
    queryKey: ["consultation-participants", consultationId],
    queryFn: () => fetchConsultationParticipants(consultationId),
    enabled: !!consultationId,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeConsultationParticipant,
    onSuccess: () => {
      // Invalidate and refetch the consultation participants data
      queryClient.invalidateQueries({
        queryKey: ["consultation-participants", consultationId],
      });
    },
    onError: (error) => {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error removing participant:", error);
    },
  });

  const handleRemoveParticipant = (userId: string) => {
    removeParticipantMutation.mutate({ consultationId, userId });
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error loading consultation data</div>;
  }

  if (!data?.consultation) {
    return <div>Consultation not found</div>;
  }

  const { consultation, participants } = data;

  const columns: ResponsiveColumn<ParticipantUser>[] = [
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

  const renderRowActions = (participant: ParticipantUser) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => handleRemoveParticipant(participant.id)}
      disabled={removeParticipantMutation.isPending}
    >
      {removeParticipantMutation.isPending ? "Removing..." : "Remove"}
    </Button>
  );

  const emptyState = (
    <div className="py-8 text-center text-muted-foreground">
      No registered participants yet.
    </div>
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
          <PageHeader
            headingAs="h1"
            title={`${consultation.consultationPlan.title} - Participants`}
            description={`${participants.length}/2 participants (1-on-1 consultation)`}
          />
        </CardHeader>
        <CardContent>
          <ResponsiveTable<ParticipantUser>
            columns={columns}
            rows={participants}
            getRowId={(p) => p.id}
            rowActions={renderRowActions}
            empty={emptyState}
          />
        </CardContent>
      </Card>
    </div>
  );
}
