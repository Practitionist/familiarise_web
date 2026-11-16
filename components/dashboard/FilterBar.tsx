"use client";

import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FilterMenu } from "./FilterMenu";

const SEARCH_DEBOUNCE_MS = 300;

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface FilterBarSearch {
  /** Required: the accessible name, e.g. "Search payments" (#1527 a11y). */
  label: string;
  placeholder?: string;
  value: string;
  /** Called 300 ms after the user stops typing. */
  onChange: (value: string) => void;
}

export interface FilterBarChips {
  /** The group's accessible name, e.g. "Status". */
  label: string;
  options: FilterOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Offers "All" (`null`), and picking the current option again clears it. */
  clearable?: boolean;
}

export interface FilterBarSelect {
  key: string;
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}

export interface FilterBarProps {
  search?: FilterBarSearch;
  chips?: FilterBarChips;
  selects?: FilterBarSelect[];
  onClear?: () => void;
  /** Whether Clear shows; defaults to "a search or chip is set". */
  canClear?: boolean;
  /** Extra controls at the end of the row, e.g. a date range. */
  children?: ReactNode;
  className?: string;
}

function DebouncedSearch({
  label,
  placeholder,
  value,
  onChange,
}: Readonly<FilterBarSearch>) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [emitted, setEmitted] = useState<string | null>(null);
  // An outside change (Clear, back/forward) replaces what is typed; the echo
  // of our own debounced emit does not, or it would eat keys typed since.
  if (value !== seen) {
    setSeen(value);
    if (value !== emitted) setDraft(value);
  }
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => {
      setEmitted(draft);
      onChangeRef.current(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, value]);

  return (
    <div className="relative min-w-[180px] max-w-sm flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={id}
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder ?? label}
        className="h-9 pl-8 text-sm"
      />
    </div>
  );
}

/**
 * The list filter row: a labelled debounced search, the chip group as one
 * "Label: Value" menu, optional selects and Clear, all on one wrapping row.
 * Pair with `useListParams` so every value lives in the URL.
 */
export function FilterBar({
  search,
  chips,
  selects,
  onClear,
  canClear,
  children,
  className,
}: Readonly<FilterBarProps>) {
  const showClear =
    onClear &&
    (canClear ?? (Boolean(search?.value) || (chips?.value ?? null) !== null));

  if (!search && !chips && !selects?.length && !children && !showClear) {
    return null;
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {search && <DebouncedSearch {...search} />}
        {chips && (
          <FilterMenu
            label={chips.label}
            options={chips.options}
            value={chips.value}
            onChange={chips.onChange}
            // A non-clearable group leads with its own "All" option.
            allValue={
              chips.clearable ? null : (chips.options[0]?.value ?? null)
            }
          />
        )}
        {selects?.map((select) => (
          <Select
            key={select.key}
            value={select.value}
            onValueChange={select.onChange}
          >
            <SelectTrigger
              className="h-9 w-auto min-w-[140px] text-sm"
              aria-label={select.label}
            >
              <SelectValue placeholder={select.label} />
            </SelectTrigger>
            <SelectContent>
              {select.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        {children}
        {showClear && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 text-muted-foreground"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
