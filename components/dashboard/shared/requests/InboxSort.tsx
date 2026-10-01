"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INBOX_SORTS,
  isInboxSort,
  type InboxSort,
} from "@/lib/dashboard/requests-inbox-state";

import { SORT_LABEL } from "./labels";

export function InboxSortControl({
  value,
  disabled,
  onChange,
}: Readonly<{
  value: InboxSort;
  disabled: boolean;
  onChange: (sort: InboxSort) => void;
}>) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (isInboxSort(next)) onChange(next);
      }}
    >
      <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Sort by">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INBOX_SORTS.map((sort) => (
          <SelectItem key={sort} value={sort} className="text-xs">
            {SORT_LABEL[sort]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
