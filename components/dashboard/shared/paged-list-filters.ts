import type {
  FilterBarProps,
  FilterOption,
} from "@/components/dashboard/FilterBar";

export const GATEWAY_FILTER_OPTIONS: FilterOption[] = [
  { value: "all", label: "All Gateways" },
  { value: "STRIPE", label: "Stripe" },
  { value: "RAZORPAY", label: "Razorpay" },
];

interface PagedSelect {
  key: string;
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}

interface PagedListFiltersInput {
  search: {
    label: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
  };
  /** Selects whose "no filter" value is "all". */
  selects: PagedSelect[];
  setPage: (page: number) => void;
}

/**
 * FilterBar props for a paged staff list: any change returns to page 1, and
 * Clear empties the search and puts every select back on "all".
 */
export function pagedListFilters({
  search,
  selects,
  setPage,
}: PagedListFiltersInput): FilterBarProps {
  const toFirstPage =
    (set: (value: string) => void) =>
    (value: string): void => {
      set(value);
      setPage(1);
    };
  return {
    search: { ...search, onChange: toFirstPage(search.onChange) },
    selects: selects.map((s) => ({ ...s, onChange: toFirstPage(s.onChange) })),
    canClear: Boolean(search.value) || selects.some((s) => s.value !== "all"),
    onClear: () => {
      search.onChange("");
      for (const s of selects) s.onChange("all");
      setPage(1);
    },
  };
}
