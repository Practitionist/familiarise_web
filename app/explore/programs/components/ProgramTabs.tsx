"use client";

import { SegmentedControl } from "@/components/ui/segmented-control";

export type ProgramTypeTab = "all" | "class" | "webinar";

/**
 * Now `SegmentedControl`.
 *
 * This was the worst of the four hand-rolled segmented controls in the app: it
 * looked like a tablist and announced as **nothing at all** — no
 * `role`, no `aria-pressed`, just `isActive` driving a background colour. A
 * screen-reader user had no way to know which of Classes / Webinars / All was
 * currently applied.
 *
 * It is still deliberately NOT a `role="tablist"`. These filter the results
 * list in place; they do not own `tabpanel`s, and `tablist` promises an
 * arrow-key roving-focus contract that a filter toggle does not implement.
 * `role="group"` + `aria-pressed` is the accurate signal.
 */
export default function ProgramTabs({
  activeTab,
  onTabChange,
  counts,
}: {
  activeTab: ProgramTypeTab;
  onTabChange: (tab: ProgramTypeTab) => void;
  /** Optional per-tab result counts, announced but not rendered. */
  counts?: Partial<Record<ProgramTypeTab, number>>;
}) {
  const options: { value: ProgramTypeTab; label: string }[] = [
    { value: "all", label: "All" },
    { value: "class", label: "Classes" },
    { value: "webinar", label: "Webinars" },
  ];

  return (
    <SegmentedControl
      label="Program type"
      value={activeTab}
      onChange={onTabChange}
      options={options.map((o) => ({
        ...o,
        srSuffix:
          typeof counts?.[o.value] === "number"
            ? `, ${counts[o.value]} available`
            : undefined,
      }))}
    />
  );
}
