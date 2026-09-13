"use client";

import { useRouter } from "next/navigation";
import { TimePicker } from "@/components/scheduling/TimePicker";
import {
  manageTimingsPolicy,
  type TimePickerSubject,
} from "@/components/scheduling/time-picker-policy";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";

/**
 * The consultant half of the manage-timings page — the allocate-mode grid
 * owns the submit here (`useEventSlotAllocation` inside it POSTs the
 * allocation and raises its own "Timings saved" toast, same as the allocate
 * route), so this only decides where to go afterwards.
 */
export function ManageTimingsClient({
  subject,
  backHref,
  title,
}: Readonly<{
  subject: TimePickerSubject;
  backHref: string;
  title: string;
}>) {
  const router = useRouter();
  // Replaces the generic "timings" crumb with the offering's own name (#1064).
  useSetBreadcrumbLabel(title);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = manageTimingsPolicy({ onSubmit: goBack });

  return (
    <TimePicker
      className="min-h-0 flex-1"
      policy={policy}
      subject={subject}
      onCancel={goBack}
    />
  );
}
