"use client";

/**
 * Participant roster for a group session — one route for webinars and classes.
 *
 * There were four of these: `webinars/[webinarId]`, `classes/[classId]`,
 * `consultations/[consultationId]` and `subscriptions/[subscriptionId]`.
 *
 * The last two were unreachable — `supportsParticipantManagement()` only
 * returns true for webinar/class, so nothing ever linked to them — and that
 * gate is right: consultations and subscriptions are 1-on-1, so their
 * "roster" was a list of two people (the consultation page literally rendered
 * `participants.length/2 (1-on-1 consultation)`). They're deleted rather than
 * wired up, along with the `getParticipantManagementUrl` branches that
 * emitted hrefs to them.
 *
 * The remaining two were ~270 lines each and collapse to this one route. Most
 * of the difference was the entity noun (`webinarEvent`/`webinarPlan` vs
 * `classEvent`/`classPlan`) and the API path segment, but not all of it: a
 * class carries `appointments: Appointment[]` while a webinar carries a single
 * `appointment | null`, so the two are narrowed rather than cast and the
 * appointment list is normalised before the participant flattening.
 */

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { effectiveMaxParticipants } from "@/lib/events/capacity";

import type { ClassEvent, WebinarEvent } from "@/types/planner-events";

/** URL segment → API path segment and the noun used in the count line. */
const EVENT_KINDS = {
  webinars: { apiSegment: "webinar", countNoun: "registered" },
  classes: { apiSegment: "class", countNoun: "participants" },
} as const;

type EventKind = keyof typeof EVENT_KINDS;

/**
 * The two responses differ in more than naming: a class carries
 * `appointments: Appointment[]`, a webinar a single `appointment | null`.
 * Narrowing on the key rather than casting keeps that difference honest.
 */
type ParticipantsResponse =
  | { webinarEvent: WebinarEvent; classEvent?: never }
  | { classEvent: ClassEvent; webinarEvent?: never };

// Registered-participant rows are flattened from the event's slot users.
type RegisteredParticipant = { id: string; name?: string; email?: string };

const fetchParticipants = async (
  apiSegment: string,
  eventId: string,
): Promise<ParticipantsResponse> => {
  const response = await fetch(`/api/participants/${apiSegment}/${eventId}`);
  if (!response.ok) throw new Error("Failed to fetch event data");
  return response.json();
};

const removeParticipant = async ({
  apiSegment,
  eventId,
  userId,
}: {
  apiSegment: string;
  eventId: string;
  userId: string;
}) => {
  const response = await fetch(
    `/api/participants/${apiSegment}/${eventId}?userId=${userId}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to remove participant");
  // Every participant DELETE handler answers 204 No Content, so parsing a body
  // here threw on the SUCCESS path — the mutation rejected after the removal
  // had already happened, the error toast fired, and the roster query was
  // never invalidated.
};

export default function EventParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();

  const eventType = params.eventType as string;
  const eventId = params.eventId as string;
  const kind = EVENT_KINDS[eventType as EventKind];

  const { data, isLoading, error } = useQuery({
    queryKey: ["event-participants", eventType, eventId],
    queryFn: () => fetchParticipants(kind.apiSegment, eventId),
    enabled: !!eventId && !!kind,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeParticipant,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["event-participants", eventType, eventId],
      });
    },
    onError: (err) => {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error removing participant:", err);
    },
  });

  // Only webinars and classes have a roster worth managing. Anything else in
  // the URL is a hand-edit or a stale link.
  if (!kind) notFound();

  const handleRemoveParticipant = (userId: string) => {
    removeParticipantMutation.mutate({
      apiSegment: kind.apiSegment,
      eventId,
      userId,
    });
  };

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error loading event data</div>;

  const event = data?.webinarEvent ?? data?.classEvent;
  if (!event) return <div>Event not found</div>;

  const plan = "webinarPlan" in event ? event.webinarPlan : event.classPlan;

  // A class has many appointments; a webinar has at most one. Normalise so
  // the flattening below is identical for both.
  const appointments =
    "appointments" in event
      ? event.appointments
      : event.appointment
        ? [event.appointment]
        : [];

  // Unique participants by user id, flattened out of the event's slots.
  const participants = Array.from(
    new Map(
      appointments
        .flatMap((appointment) =>
          (appointment.slotsOfAppointment || []).flatMap(
            (slot) => slot.user || [],
          ),
        )
        .map((user) => [user.id, user]),
    ).values(),
  );

  // The instance may override the plan's capacity.
  const effectiveCapacity = effectiveMaxParticipants(event, plan);

  const registeredColumns: ResponsiveColumn<RegisteredParticipant>[] = [
    { key: "name", header: "Name", primary: true, cell: (p) => p.name },
    { key: "email", header: "Email", cell: (p) => p.email },
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

  return (
    <>
      <DashboardHeader
        title={`${plan.title} — Participants`}
        subtitle={`${participants.length}/${effectiveCapacity} ${kind.countNoun}${
          participants.length >= effectiveCapacity ? " · sold out" : ""
        }`}
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
          <ResponsiveTable<RegisteredParticipant>
            columns={registeredColumns}
            rows={participants}
            getRowId={(p) => p.id}
            rowActions={renderRegisteredActions}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                No registered participants yet.
              </div>
            }
          />
        </CardContent>
      </Card>
    </>
  );
}
