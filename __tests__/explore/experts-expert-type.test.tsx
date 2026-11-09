/**
 * @jest-environment jsdom
 */
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

jest.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    formatPrice: (paise: number) => `₹${paise / 100}`,
    currency: "INR",
  }),
}));

import { FilterPanel } from "@/app/explore/experts/components/FilterPanel";
import { useExpertFilterChips } from "@/app/explore/experts/hooks/useExpertFilterChips";
import {
  DEFAULT_EXPERT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  type IExpertFilters,
  type IExpertsMetaData,
} from "@/app/explore/experts/utils";

beforeAll(() => {
  // The price slider measures itself, which jsdom cannot.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const METADATA = {
  domains: [],
  subdomains: [],
  tags: [],
  consultantMetadata: {
    totalConsultants: 15,
    affiliationCounts: { all: 15, independent: 9, agency: 6 },
    consultantsByDomain: [],
    averageRating: 0,
    publishedReviewCount: 0,
    completedSessions: 0,
  },
  availableLanguages: [],
  availableCompanies: [],
} satisfies IExpertsMetaData;

type PanelProps = ComponentProps<typeof FilterPanel>;

function renderPanel(filters: Partial<IExpertFilters> = {}) {
  const props: PanelProps = {
    metadata: METADATA,
    filters: { ...DEFAULT_EXPERT_FILTERS, ...filters },
    updateFilters: jest.fn(),
  };
  render(<FilterPanel {...props} />);
  return props;
}

describe("Filters panel: expert type", () => {
  it("offers All, Independent and Agency / Org with their counts", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Expert type" });
    expect(group).toHaveTextContent("All experts");
    expect(group).toHaveTextContent("15");
    expect(group).toHaveTextContent("Independent");
    expect(group).toHaveTextContent("9");
    expect(group).toHaveTextContent("Agency / Org");
    expect(group).toHaveTextContent("6");
  });

  it("starts on All experts", () => {
    renderPanel();
    expect(screen.getByRole("radio", { name: /all experts/i })).toBeChecked();
  });

  it("filters to independent experts", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: /independent/i }));
    expect(props.updateFilters).toHaveBeenCalledWith({
      affiliationType: "independent",
    });
  });

  it("filters to agency experts", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: /agency/i }));
    expect(props.updateFilters).toHaveBeenCalledWith({
      affiliationType: "agency",
    });
  });

  it("returns to everyone from All experts", () => {
    const props = renderPanel({ affiliationType: "agency" });
    expect(screen.getByRole("radio", { name: /agency/i })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /all experts/i }));
    expect(props.updateFilters).toHaveBeenCalledWith({ affiliationType: null });
  });
});

describe("expert type as an active filter", () => {
  const formatPrice = (paise: number) => `₹${paise / 100}`;

  const setup = (filters: IExpertFilters) => {
    const updateFilters = jest.fn();
    const { result } = renderHook(() =>
      useExpertFilterChips(
        filters,
        METADATA,
        updateFilters,
        jest.fn(),
        formatPrice,
      ),
    );
    return { result, updateFilters };
  };

  it("shows no chip for everyone", () => {
    const { result } = setup(DEFAULT_EXPERT_FILTERS);
    expect(result.current.chips).toEqual([]);
  });

  it("shows a Type chip, so the Filters badge and the count see it", () => {
    const { result } = setup({
      ...DEFAULT_EXPERT_FILTERS,
      affiliationType: "agency",
    });
    expect(result.current.chips).toEqual([
      expect.objectContaining({ label: "Type", value: "Agency / Org" }),
    ]);
  });

  it("removing the chip goes back to everyone", () => {
    const { result, updateFilters } = setup({
      ...DEFAULT_EXPERT_FILTERS,
      affiliationType: "independent",
    });
    result.current.removeChip(result.current.chips[0].key);
    expect(updateFilters).toHaveBeenCalledWith({ affiliationType: null });
  });
});

describe("expert filters in the URL", () => {
  it("round-trips the expert type", () => {
    const filters = {
      ...DEFAULT_EXPERT_FILTERS,
      affiliationType: "agency" as const,
    };
    const qs = filtersToSearchParams(filters);
    expect(qs).toContain("affiliationType=agency");
    const parsed = filtersFromSearchParams(
      new URLSearchParams(qs) as Parameters<typeof filtersFromSearchParams>[0],
    );
    expect(parsed.affiliationType).toBe("agency");
  });

  it("ignores the retired ?orgKind= instead of carrying it as a hidden filter", () => {
    const parsed = filtersFromSearchParams(
      new URLSearchParams(
        "affiliationType=agency&orgKind=AGENCY",
      ) as Parameters<typeof filtersFromSearchParams>[0],
    );
    expect(parsed.affiliationType).toBe("agency");
    expect(parsed).not.toHaveProperty("orgKind");
  });
});
