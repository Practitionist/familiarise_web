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
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface User {
  id: string;
  name?: string;
  email?: string;
}

interface SubscriptionPlan {
  id: string;
  title: string;
}

interface Subscription {
  id: string;
  subscriptionPlan: SubscriptionPlan;
}

interface SubscriptionParticipantsData {
  subscription: Subscription;
  participants: User[];
}

// Fetcher function for subscription participants
const fetchSubscriptionParticipants = async (
  subscriptionId: string,
): Promise<SubscriptionParticipantsData> => {
  const response = await fetch(
    `/api/participants/subscriptions/${subscriptionId}`,
  );
  if (!response.ok) {
    throw new Error("Failed to fetch subscription data");
  }
  return response.json();
};

// Fetcher function for removing a participant
const removeSubscriptionParticipant = async ({
  subscriptionId,
  userId,
}: {
  subscriptionId: string;
  userId: string;
}) => {
  const response = await fetch(
    `/api/participants/subscriptions/${subscriptionId}?userId=${userId}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    throw new Error("Failed to remove participant");
  }

  return response.json();
};

export default function SubscriptionParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const subscriptionId = params.subscriptionId as string;

  const { data, isLoading, error } = useQuery({
    queryKey: ["subscription-participants", subscriptionId],
    queryFn: () => fetchSubscriptionParticipants(subscriptionId),
    enabled: !!subscriptionId,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeSubscriptionParticipant,
    onSuccess: () => {
      // Invalidate and refetch the subscription participants data
      queryClient.invalidateQueries({
        queryKey: ["subscription-participants", subscriptionId],
      });
    },
    onError: (error) => {
      console.error("Error removing participant:", error);
    },
  });

  const handleRemoveParticipant = (userId: string) => {
    removeParticipantMutation.mutate({ subscriptionId, userId });
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error loading subscription data</div>;
  }

  if (!data?.subscription) {
    return <div>Subscription not found</div>;
  }

  const { subscription, participants } = data;

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
              {subscription.subscriptionPlan.title} - Participants
            </CardTitle>
            <p className="text-sm text-gray-500">
              {participants.length}/2 participants (1-on-1 subscription)
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
