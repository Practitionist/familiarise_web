"use client";

import { useRouter } from "next/navigation";
import { TimePicker } from "@/components/scheduling/TimePicker";
import {
  allocatePolicy,
  type TimePickerSubject,
} from "@/components/scheduling/time-picker-policy";
import { toast } from "@/components/ui/use-toast";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";

/**
 * The consultant's allocation surface, replacing the dialog the requests table
 * used to open. The grid owns the submit here — `useEventSlotAllocation`
 * inside it POSTs the allocation — so this only decides where to go
 * afterwards.
 */
export function AllocateClient({
  subject,
  backHref,
  title,
  pinnedAt,
}: Readonly<{
  subject: TimePickerSubject;
  backHref: string;
  title: string;
  /** Open the grid on this instant instead of the resolved focus (#1703 F5). */
  pinnedAt?: Date | null;
}>) {
  const router = useRouter();
  // Replaces the generic "allocate" crumb with the booking's own name (#1064).
  useSetBreadcrumbLabel(title);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = allocatePolicy({
    onSubmit: () => {
      toast({
        title: "Schedule confirmed",
        description: "All session times have been scheduled.",
      });
      goBack();
    },
    // 409: another session allocated this request first. The hook already
    // toasted allocatedElsewhere() — this only navigates (a second toast
    // here double-announced it). The list IS the answer — the row will
    // simply be gone.
    onConflict: () => {
      goBack();
    },
  });

  return (
    <TimePicker
      className="min-h-0 flex-1"
      policy={policy}
      subject={subject}
      focusAt={pinnedAt ?? undefined}
      onCancel={goBack}
      // The legend lives between the grid and the action footer here: the
      // footer is always on screen, and the top space goes to the heatmap.
      legendPosition="bottom"
    />
  );
}
