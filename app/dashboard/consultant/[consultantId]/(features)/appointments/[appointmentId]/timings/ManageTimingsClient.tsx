"use client";

import { useRouter } from "next/navigation";
import { SlotPicker } from "@/components/scheduling/SlotPicker";
import {
  manageTimingsPolicy,
  type SlotPickerSubject,
} from "@/components/scheduling/slot-picker-policy";

/**
 * The consultant half of the manage-timings page — the allocate-mode grid
 * owns the submit here (`useEventSlotAllocation` inside it POSTs the
 * allocation and raises its own "Timings saved" toast, same as the allocate
 * route), so this only decides where to go afterwards.
 */
export function ManageTimingsClient({
  subject,
  backHref,
}: Readonly<{ subject: SlotPickerSubject; backHref: string }>) {
  const router = useRouter();

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = manageTimingsPolicy({ onSubmit: goBack });

  return (
    <SlotPicker
      className="min-h-[70vh] flex-1"
      policy={policy}
      subject={subject}
      onCancel={goBack}
    />
  );
}
