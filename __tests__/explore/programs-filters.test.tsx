/**
 * @jest-environment jsdom
 */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/navigation/history", () => ({ replaceUrl: jest.fn() }));
jest.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    formatPrice: (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`,
  }),
}));

import AdvancedFilters from "@/app/explore/programs/components/AdvancedFilters";
import ResultsToolbar from "@/app/explore/programs/components/ResultsToolbar";
import { useProgramsFilters } from "@/app/explore/programs/hooks/useProgramsFilters";

beforeAll(() => {
  // Radix popovers measure with ResizeObserver, which jsdom does not ship.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const TOPICS = [
  { id: "t1", name: "Design", programCount: 3 },
  { id: "t2", name: "Python", programCount: 5 },
];

type FilterProps = ComponentProps<typeof AdvancedFilters>;

function renderFilters(overrides: Partial<FilterProps> = {}) {
  const props: FilterProps = {
    filters: {},
    onFiltersChange: jest.fn(),
    localSearch: "",
    onLocalSearchChange: jest.fn(),
    selectedLevel: "all",
    onLevelChange: jest.fn(),
    uniqueLevels: [],
    languages: ["English", "Hindi"],
    topics: TOPICS,
    ...overrides,
  };
  render(<AdvancedFilters {...props} />);
  return props;
}

describe("AdvancedFilters", () => {
  it("leads with a full-width search that reports what is typed", () => {
    const props = renderFilters();
    fireEvent.change(screen.getByLabelText("Search programs"), {
      target: { value: "python" },
    });
    expect(props.onLocalSearchChange).toHaveBeenCalledWith("python");
  });

  it("hides the clear button while the search is empty", () => {
    renderFilters();
    expect(screen.queryByLabelText("Clear search")).toBeNull();
  });

  it("offers the clear button once there is text", () => {
    const props = renderFilters({ localSearch: "pyth" });
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(props.onLocalSearchChange).toHaveBeenCalledWith("");
  });

  it("toggles topics from a dropdown that stays open for the next pick", () => {
    const props = renderFilters();
    fireEvent.click(screen.getByRole("button", { name: /all topics/i }));

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]);
    expect(props.onFiltersChange).toHaveBeenCalledWith({ topicIds: ["t2"] });
    // Still open: the other topic is still there to pick.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("unchecking the last topic clears the filter", () => {
    const props = renderFilters({ filters: { topicIds: ["t2"] } });
    fireEvent.click(screen.getByRole("button", { name: /1 selected/i }));
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(props.onFiltersChange).toHaveBeenCalledWith({ topicIds: undefined });
  });

  it("shows the active price band in rupees, not paise", () => {
    renderFilters({ filters: { minPrice: 50_000, maxPrice: 200_000 } });
    expect(screen.getByText("₹500 – ₹2,000")).toBeInTheDocument();
  });
});

describe("ResultsToolbar", () => {
  const base = {
    count: 24,
    hasMore: true,
    isLoading: false,
    sort: undefined,
    onSortChange: jest.fn(),
    viewMode: "list" as const,
    onViewModeChange: jest.fn(),
  };

  it("counts what is loaded, with a plus while more is coming", () => {
    render(<ResultsToolbar {...base} />);
    expect(screen.getByRole("status")).toHaveTextContent("24+ programs");
  });

  it("marks the current layout and switches on click", () => {
    render(<ResultsToolbar {...base} />);
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(base.onViewModeChange).toHaveBeenCalledWith("grid");
  });
});

describe("useProgramsFilters view mode", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts as a list", () => {
    const { result } = renderHook(() => useProgramsFilters());
    expect(result.current.viewMode).toBe("list");
  });

  it("remembers a switch to the grid across visits", () => {
    const first = renderHook(() => useProgramsFilters());
    act(() => first.result.current.setViewMode("grid"));
    expect(window.localStorage.getItem("programs-view-mode")).toBe("grid");
    first.unmount();

    const second = renderHook(() => useProgramsFilters());
    expect(second.result.current.viewMode).toBe("grid");
  });

  it("ignores a stored value that is not a layout", () => {
    window.localStorage.setItem("programs-view-mode", "carousel");
    const { result } = renderHook(() => useProgramsFilters());
    expect(result.current.viewMode).toBe("list");
  });
});

describe("useProgramsFilters search debounce", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const advance = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  it("mirrors keystrokes at once but queries only after typing pauses", () => {
    const { result } = renderHook(() => useProgramsFilters());

    for (const text of ["py", "pyt", "pyth", "pytho", "python"]) {
      act(() => result.current.onLocalSearchChange(text));
    }
    // The input is responsive; the query has not changed yet.
    expect(result.current.localSearchValue).toBe("python");
    expect(result.current.filters.search).toBeUndefined();

    advance(300);
    expect(result.current.filters.search).toBe("python");
  });

  it("restarts the wait on every keystroke", () => {
    const { result } = renderHook(() => useProgramsFilters());

    act(() => result.current.onLocalSearchChange("py"));
    advance(200);
    act(() => result.current.onLocalSearchChange("pyt"));
    advance(200);
    expect(result.current.filters.search).toBeUndefined();

    advance(100);
    expect(result.current.filters.search).toBe("pyt");
  });

  it("does not query for a single character or stray spaces", () => {
    const { result } = renderHook(() => useProgramsFilters());

    act(() => result.current.onLocalSearchChange("p"));
    advance(300);
    expect(result.current.filters.search).toBeUndefined();

    act(() => result.current.onLocalSearchChange("  py  "));
    advance(300);
    expect(result.current.filters.search).toBe("py");
  });

  it("keeps the same filters object when the term did not change", () => {
    const { result } = renderHook(() => useProgramsFilters());
    act(() => result.current.onLocalSearchChange("py"));
    advance(300);
    const before = result.current.filters;

    act(() => result.current.onLocalSearchChange("py "));
    advance(300);
    expect(result.current.filters).toBe(before);
  });
});
