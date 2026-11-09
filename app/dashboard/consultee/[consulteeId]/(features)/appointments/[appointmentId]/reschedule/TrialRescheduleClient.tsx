"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useEventActions } from "@/components/appointments/consultee/useEventActions";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { TrialSlotPicker } from "@/app/explore/experts/[consultantId]/components/TrialSlotPicker";
import { useSession } from "@/lib/auth-client";
import { leadMsFor } from "@/lib/booking/lead-time";
import type { SlotWithStatus } from "@/lib/scheduling/booking-windows";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { trialProposalAtoms } from "@/lib/trials/proposal-atoms";

/**
 * The consultee's trial reschedule: the expert page's slot list at the
 * reschedule lead (24 h), one new window of the trial's length. A time in the
 * expert's open hours that both calendars have free confirms at once; the
 * route refuses a second move by the same side.
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
  const [selected, setSelected] = useState<SlotWithStatus | null>(null);
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
    const moved = await actions.handleReschedule(
      undefined,
      trialProposalAtoms(
        new Date(selected.startsAt),
        new Date(selected.endsAt),
      ),
      undefined,
      zone.zone,
    );
    if (moved) goBack();
    else setSelected(null);
  };

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <p className="text-sm text-muted-foreground">
        A trial can be moved once by each side, at least 24 hours before it
        starts. Pick a new time from the expert&apos;s open hours.
      </p>
      <TrialSlotPicker
        consultantId={consultantId}
        consulteeUserId={session?.user?.id}
        trialDurationMinutes={trialDurationMinutes}
        leadMs={leadMsFor("reschedule")}
        timezone={zone.zone}
        selected={selected}
        onSelect={setSelected}
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
