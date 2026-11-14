"use client";

import { useRouter } from "next/navigation";
import { TimePicker } from "@/components/scheduling/TimePicker";
import {
  allocatePolicy,
  type TimePickerSubject,
} from "@/components/scheduling/time-picker-policy";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";

/**
 * The consultant's allocation surface, replacing the dialog the requests table
 * used to open. The grid owns the submit here — `useEventSlotAllocation`
 * inside it POSTs the allocation — so this only decides where to go
 * afterwards.
 */
export function AllocateClient({
  subject,
  settled,
  backHref,
  title,
  pinnedAt,
  viewerZone,
  warnings,
}: Readonly<{
  subject: TimePickerSubject;
  /** Paid (or free): decides the lead time a placed session needs. */
  settled: boolean;
  backHref: string;
  title: string;
  /** Open the grid on this instant instead of the resolved focus (#1703 F5). */
  pinnedAt?: Date | null;
  /** The viewer's profile zone from the page, so the grid matches the dashboard (#1703 QA-1). */
  viewerZone: string | null;
  /** Feasibility warnings for a subscription's coming weeks, shown in the tray. */
  warnings?: string[];
}>) {
  const router = useRouter();
  // Replaces the generic "allocate" crumb with the booking's own name (#1064).
  useSetBreadcrumbLabel(title);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  // The grid's hook already announced the outcome (full, partial or saved
  // times), so these only navigate.
  const policy = allocatePolicy(
    {
      onSubmit: goBack,
      // Allocated elsewhere, or no longer allocatable: the list is the answer.
      onConflict: goBack,
    },
    { settled, replacing: subject.hasReleasedSlots === true },
  );

  return (
    <TimePicker
      className="min-h-0 flex-1"
      policy={policy}
      subject={subject}
      focusAt={pinnedAt ?? undefined}
      viewerZone={viewerZone}
      onCancel={goBack}
      // Only the request's tentative count moved: reload it and stay here.
      onRequestRefresh={router.refresh}
      warnings={warnings}
    />
  );
}
