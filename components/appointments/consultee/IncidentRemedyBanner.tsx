"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CalendarClock } from "lucide-react";
import type { z } from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { actionFailureMessage, requireJsonResponse } from "@/lib/fetch-helpers";
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";
import { REFUND_TIMING_BY_RAIL } from "@/lib/payments/operations/refund-policy-copy";
import {
  OpenIncidentRemediesResponseSchema,
  type OpenIncidentRemedySchema,
} from "@/schemas/appointments";

type OpenRemedy = z.infer<typeof OpenIncidentRemedySchema>;

export const INCIDENT_REMEDIES_QUERY_KEY = ["incident-remedies"] as const;

const WHEN = "EEE, d MMM · h:mm a";

async function fetchOpenRemedies(
  appointmentId?: string,
): Promise<OpenRemedy[]> {
  const qs = appointmentId
    ? `?appointmentId=${encodeURIComponent(appointmentId)}`
    : "";
  const res = await fetch(`/api/incidents/remedies${qs}`);
  const body = await requireJsonResponse(res, "Failed to load");
  return OpenIncidentRemediesResponseSchema.parse(body).remedies;
}

/**
 * A 1:1 an outage voided, while its free rebook is open: rebook the same
 * expert, or take the 100 % refund now instead of waiting for it.
 */
export function IncidentRemedyBanner({
  consulteeId,
  zone,
  appointmentId,
}: Readonly<{
  consulteeId: string;
  /** The viewer's IANA zone; every time here is shown in it. */
  zone: string;
  /** Scopes the banner to one booking's detail page. */
  appointmentId?: string;
}>) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState<OpenRemedy | null>(null);
  const { data } = useQuery({
    queryKey: [...INCIDENT_REMEDIES_QUERY_KEY, appointmentId ?? "all"],
    queryFn: () => fetchOpenRemedies(appointmentId),
    staleTime: 60_000,
  });
  const refundNow = useMutation({
    mutationFn: async (remedy: OpenRemedy) => {
      const res = await fetch(
        `/api/incidents/remedies/${encodeURIComponent(remedy.id)}/refund-now`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      return requireJsonResponse(res, "Couldn't start your refund");
    },
    onSuccess: (_body, remedy) => {
      toast({
        title: "Your refund is on its way",
        description: `We are refunding 100 % of what you paid. ${REFUND_TIMING_BY_RAIL[remedy.fundingRail]}`,
      });
    },
    onError: (error) => {
      toast({
        title: "Couldn't start your refund",
        description: actionFailureMessage(error, "Please try again."),
        variant: "destructive",
      });
    },
    onSettled: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({
        queryKey: INCIDENT_REMEDIES_QUERY_KEY,
      });
    },
  });

  const remedies = data ?? [];
  if (remedies.length === 0) return null;
  const when = (iso: string) =>
    `${formatInViewerZone(iso, zone, WHEN)} ${zoneLabel(iso, zone)}`;

  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="incident-remedy-banner"
    >
      {remedies.map((remedy) => (
        <div
          key={remedy.id}
          className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/80 px-3.5 py-2.5 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              A platform outage voided <strong>{remedy.title}</strong> on{" "}
              {when(remedy.sessionStartsAt)}. Rebook free with{" "}
              {remedy.expertName ?? "your expert"} by {when(remedy.dueAt)}, or
              we refund 100 % then.
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" asChild>
              <Link
                href={`/dashboard/consultee/${consulteeId}/appointments/${remedy.appointmentId}/rebook`}
              >
                <CalendarClock className="mr-1.5 h-4 w-4" />
                Rebook free
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={refundNow.isPending}
              onClick={() => setConfirming(remedy)}
            >
              Refund now
            </Button>
          </div>
        </div>
      ))}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !refundNow.isPending) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take the full refund now?</AlertDialogTitle>
            <AlertDialogDescription>
              We refund 100 % of what you paid for {confirming?.title}, and the
              free rebook is no longer offered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={refundNow.isPending}>
              Keep my options
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={refundNow.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirming) refundNow.mutate(confirming);
              }}
            >
              Refund now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
