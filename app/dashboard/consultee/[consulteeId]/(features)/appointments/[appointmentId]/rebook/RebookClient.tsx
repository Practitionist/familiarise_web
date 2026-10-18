"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { TimePicker } from "@/components/scheduling/TimePicker";
import {
  rebookIncidentPolicy,
  type TimePickerSubject,
} from "@/components/scheduling/time-picker-policy";
import { INCIDENT_REMEDIES_QUERY_KEY } from "@/components/appointments/consultee/IncidentRemedyBanner";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { useToast } from "@/hooks/use-toast";
import { actionFailureMessage, requireJsonResponse } from "@/lib/fetch-helpers";

/** The shared picker under the rebook policy; the submit confirms the free session at once. */
export function RebookClient({
  remedyId,
  title,
  subject,
  backHref,
  viewerZone,
}: Readonly<{
  remedyId: string;
  title: string;
  subject: TimePickerSubject;
  backHref: string;
  viewerZone: string;
}>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  // One key per chosen time, so a double submit replays the first answer.
  const attempt = useRef<{ startsAt: string; key: string } | null>(null);
  useSetBreadcrumbLabel(title);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = rebookIncidentPolicy({
    onSubmit: async ({ proposedSlots }) => {
      const startsAt = proposedSlots?.map((slot) => slot.startsAt).sort()[0];
      if (!startsAt) return;
      if (attempt.current?.startsAt !== startsAt) {
        attempt.current = { startsAt, key: crypto.randomUUID() };
      }
      const idempotencyKey = attempt.current.key;
      setSubmitting(true);
      try {
        const res = await fetch(
          `/api/incidents/remedies/${encodeURIComponent(remedyId)}/rebook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({ startsAt }),
          },
        );
        await requireJsonResponse(res, "Couldn't rebook this session");
        toast({
          title: "Rebooked, free of charge",
          description: "Your expert has been told about the new time.",
        });
        await Promise.all(
          [
            INCIDENT_REMEDIES_QUERY_KEY,
            ["appointment-detail"],
            ["consultee-events"],
          ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
        goBack();
      } catch (error) {
        // The page and the selection stay, so another time can be tried.
        toast({
          title: "Couldn't rebook this session",
          description: actionFailureMessage(error, "Please try another time."),
          variant: "destructive",
        });
      } finally {
        setSubmitting(false);
      }
    },
  });

  return (
    <TimePicker
      className="min-h-0 flex-1"
      policy={policy}
      subject={subject}
      isSubmitting={submitting}
      onCancel={goBack}
      viewerZone={viewerZone}
    />
  );
}
