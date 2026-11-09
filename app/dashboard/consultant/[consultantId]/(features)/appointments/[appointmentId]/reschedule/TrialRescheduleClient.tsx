"use client";

import { useRouter } from "next/navigation";

import { TrialScheduleCalendar } from "@/components/dashboard/shared/requests/components/TrialScheduleCalendar";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { trialProposalAtoms } from "@/lib/trials/proposal-atoms";
import { useConsultantEventActions } from "../../components/useConsultantEventActions";

/**
 * The consultant's trial reschedule: the trial picker at the reschedule lead
 * (24 h) with the learner's busy times greyed out. The new time is sent to the
 * learner to accept; the trial keeps its time until they do.
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

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  return (
    <TrialScheduleCalendar
      consultantId={consultantId}
      trialDurationMinutes={trialDurationMinutes}
      consulteeUserId={consulteeUserId}
      consulteeUserName={consulteeName}
      purpose="reschedule"
      heading="Propose a new trial time"
      confirmLabel="Send new time"
      isProcessing={actions.isLoading}
      onCancel={goBack}
      onSlotSelect={(slot) =>
        void actions
          .handleReschedule(
            undefined,
            trialProposalAtoms(slot.startsAt, slot.endsAt),
          )
          .then((moved) => {
            if (moved) goBack();
          })
      }
    />
  );
}
