"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Loader2 } from "lucide-react";

import {
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { trialProposalAtoms } from "@/lib/trials/proposal-atoms";
import { createSubmissionKeys } from "@/lib/api/submission-key";
import { useConsultantEventActions } from "../../components/useConsultantEventActions";

/**
 * The consultant's trial reschedule: the single-time picker at the reschedule
 * lead (24 h), inside published hours, with the learner's busy times taken.
 * The new time goes to the learner to accept; the trial keeps its time until
 * they do.
 */
export function TrialRescheduleClient({
  consultantId,
  appointmentId,
  consulteeUserId,
  consulteeName,
  trialDurationMinutes,
  title,
  backHref,
}: Readonly<{
  consultantId: string;
  appointmentId: string;
  consulteeUserId: string;
  consulteeName?: string;
  trialDurationMinutes: number;
  title: string;
  backHref: string;
}>) {
  const router = useRouter();
  useSetBreadcrumbLabel(title);
  const actions = useConsultantEventActions({
    consultantId,
    appointmentId,
    rawOccurrences: [],
    title,
    type: "Trial",
  });
  const [submissionKeyFor] = useState(createSubmissionKeys);
  const { data: session } = useSession();
  const zone = useDisplayZone(session?.user?.timezone ?? null);
  const [picked, setPicked] = useState<SingleTimeValue | null>(null);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const send = () => {
    if (!picked) return;
    const atoms = trialProposalAtoms(
      new Date(picked.startsAt),
      new Date(picked.endsAt),
    );
    void actions
      .handleReschedule(
        undefined,
        atoms,
        undefined,
        undefined,
        submissionKeyFor(atoms),
      )
      .then((moved) => {
        if (moved) goBack();
      });
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Propose a new trial time</h2>
        <p className="text-sm text-muted-foreground">
          {consulteeName
            ? `Pick a ${trialDurationMinutes}-minute time for the trial with ${consulteeName}. They accept it before it moves.`
            : `Pick a ${trialDurationMinutes}-minute time for the trial. The learner accepts it before it moves.`}
        </p>
        <ZoneSwitch
          zone={zone.zone}
          usingDeviceZone={zone.usingDeviceZone}
          canSwitch={zone.canSwitch}
          onToggle={zone.toggle}
          className="mt-2"
        />
      </div>
      <SingleTimePicker
        consultantId={consultantId}
        consulteeUserId={consulteeUserId}
        sessionMinutes={trialDurationMinutes}
        zone={zone.zone}
        theme="light"
        audience="buyer"
        purpose="reschedule"
        value={picked}
        onChange={setPicked}
      />
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={goBack} disabled={actions.isLoading}>
          Cancel
        </Button>
        <Button onClick={send} disabled={!picked || actions.isLoading}>
          {actions.isLoading ? (
            <>
              <Loader2
                aria-hidden="true"
                className="mr-2 h-4 w-4 animate-spin"
              />
              Sending…
            </>
          ) : (
            "Send new time"
          )}
        </Button>
      </div>
    </div>
  );
}
