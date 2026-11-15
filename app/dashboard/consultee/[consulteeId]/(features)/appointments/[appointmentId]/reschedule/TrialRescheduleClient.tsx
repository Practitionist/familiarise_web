"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useEventActions } from "@/components/appointments/consultee/useEventActions";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import {
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import { useSession } from "@/lib/auth-client";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { trialProposalAtoms } from "@/lib/trials/proposal-atoms";
import { createSubmissionKeys } from "@/lib/api/submission-key";

/**
 * The consultee's trial reschedule: the single-time picker at the reschedule
 * lead (24 h), one new time of the trial's length. A time in the expert's open
 * hours that both calendars have free confirms at once; the route refuses a
 * second move by the same side.
 */
export function TrialRescheduleClient({
  appointmentId,
  consultantId,
  trialDurationMinutes,
  title,
  backHref,
}: Readonly<{
  appointmentId: string;
  consultantId: string;
  trialDurationMinutes: number;
  title: string;
  backHref: string;
}>) {
  const router = useRouter();
  useSetBreadcrumbLabel(title);
  const { data: session } = useSession();
  const zone = useDisplayZone(session?.user?.timezone ?? null);
  const [selected, setSelected] = useState<SingleTimeValue | null>(null);
  const [submissionKeyFor] = useState(createSubmissionKeys);
  const actions = useEventActions({
    appointmentId,
    rawOccurrences: [],
    title,
    consultant: "",
    type: "Trial",
  });

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const submit = async () => {
    if (!selected) return;
    const atoms = trialProposalAtoms(
      new Date(selected.startsAt),
      new Date(selected.endsAt),
    );
    const moved = await actions.handleReschedule(
      undefined,
      atoms,
      undefined,
      zone.zone,
      submissionKeyFor(atoms),
    );
    if (moved) goBack();
    else setSelected(null);
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <p className="text-sm text-muted-foreground">
        A trial can be moved once by each side, at least 24 hours before it
        starts. Pick a new time from the expert&apos;s open hours.
      </p>
      <ZoneSwitch
        zone={zone.zone}
        usingDeviceZone={zone.usingDeviceZone}
        canSwitch={zone.canSwitch}
        onToggle={zone.toggle}
      />
      <SingleTimePicker
        consultantId={consultantId}
        consulteeUserId={session?.user?.id}
        sessionMinutes={trialDurationMinutes}
        zone={zone.zone}
        theme="light"
        audience="buyer"
        purpose="reschedule"
        value={selected}
        onChange={setSelected}
      />
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={goBack} disabled={actions.isLoading}>
          Keep current time
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={!selected || actions.isLoading}
        >
          {actions.isLoading ? "Moving…" : "Move trial to this time"}
        </Button>
      </div>
    </div>
  );
}
