import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import { AppointmentsFilterBar } from "@/components/appointments/AppointmentsFilterBar";
import type { TypeFilter } from "@/components/appointments/AppointmentsFilterBar";
import {
  dateRangeBounds,
  datePresets,
  dateRangeLabel,
  type DateRange,
} from "@/components/dashboard/DateRangeMenu";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { FilterMenu } from "@/components/dashboard/FilterMenu";

// Sunday 15 Nov 2026, 15:30 in Kolkata.
const ZONE = "Asia/Kolkata";
const NOW = new Date("2026-11-15T10:00:00Z");

describe("datePresets", () => {
  it("looks forward on to-do tabs, with the week running Monday to Sunday", () => {
    const presets = datePresets("future", ZONE, NOW);
    expect(presets.map((p) => p.label)).toEqual([
      "Today",
      "Tomorrow",
      "This week",
      "Next 7 days",
      "Next 30 days",
    ]);
    expect(presets[0].range).toEqual({ from: "2026-11-15", to: "2026-11-15" });
    expect(presets[1].range).toEqual({ from: "2026-11-16", to: "2026-11-16" });
    expect(presets[2].range).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    // Both ends are inclusive, so "Next 7 days" is today plus six.
    expect(presets[3].range).toEqual({ from: "2026-11-15", to: "2026-11-21" });
    expect(presets[4].range).toEqual({ from: "2026-11-15", to: "2026-12-14" });
  });

  it("looks back on done tabs", () => {
    const presets = datePresets("past", ZONE, NOW);
    expect(presets.map((p) => p.label)).toEqual([
      "Today",
      "Last 7 days",
      "Last 30 days",
      "This month",
      "Last 3 months",
    ]);
    expect(presets[1].range).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(presets[2].range).toEqual({ from: "2026-10-17", to: "2026-11-15" });
    expect(presets[3].range).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(presets[4].range).toEqual({ from: "2026-08-15", to: "2026-11-15" });
  });

  it("counts Last 3 months in calendar months, clamped to the month's end", () => {
    const presets = datePresets("past", ZONE, new Date("2026-05-31T06:00:00Z"));
    expect(presets[4].range).toEqual({ from: "2026-02-28", to: "2026-05-31" });
  });

  it("takes today from the viewer's zone, not the device's", () => {
    // 20:00 UTC on 15 Nov is already 01:30 on 16 Nov in Kolkata.
    const late = new Date("2026-11-15T20:00:00Z");
    expect(datePresets("any", ZONE, late)[0].range).toEqual({
      from: "2026-11-16",
      to: "2026-11-16",
    });
    expect(datePresets("any", "America/New_York", late)[0].range).toEqual({
      from: "2026-11-15",
      to: "2026-11-15",
    });
  });
});

describe("dateRangeBounds", () => {
  it("spans whole calendar days in the viewer's zone", () => {
    expect(
      dateRangeBounds({ from: "2026-11-16", to: "2026-11-16" }, ZONE),
    ).toEqual({
      fromMs: Date.parse("2026-11-15T18:30:00Z"),
      toMs: Date.parse("2026-11-16T18:30:00Z") - 1,
    });
  });

  it("leaves an empty side open", () => {
    expect(dateRangeBounds({ from: "", to: "2026-11-16" }, "UTC")).toEqual({
      fromMs: null,
      toMs: Date.parse("2026-11-17T00:00:00Z") - 1,
    });
  });
});

describe("dateRangeLabel", () => {
  const presets = datePresets("future", ZONE, NOW);
  it.each<[DateRange, string]>([
    [{ from: "", to: "" }, "Any date"],
    [{ from: "2026-11-15", to: "2026-11-21" }, "Next 7 days"],
    [{ from: "2026-11-20", to: "2026-11-20" }, "20 Nov"],
    [{ from: "2026-11-20", to: "2026-11-25" }, "20 Nov – 25 Nov"],
    [{ from: "2026-11-20", to: "" }, "From 20 Nov"],
    [{ from: "", to: "2026-11-25" }, "Until 25 Nov"],
  ])("%j → %s", (range, label) => {
    expect(dateRangeLabel(range, presets)).toBe(label);
  });
});

describe("FilterMenu", () => {
  const options = [
    { value: "OPEN", label: "Open", count: 3 },
    { value: "CLOSED", label: "Closed", count: 1 },
  ];

  it("offers an All item for a clearable group and clears back to null", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <FilterMenu
        label="Status"
        options={options}
        value={null}
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Status: All" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear status filter" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Status: All" }));
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(onChange).toHaveBeenLastCalledWith("CLOSED");

    rerender(
      <FilterMenu
        label="Status"
        options={options}
        value="CLOSED"
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear status filter" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("uses the group's own All option when one is given", () => {
    const onChange = jest.fn();
    render(
      <FilterMenu
        label="Role"
        options={[{ value: "ALL", label: "All" }, ...options]}
        value="ALL"
        allValue="ALL"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Role: All" }));
    // One All item, not a second synthetic one.
    expect(screen.getAllByRole("button", { name: /^All/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(onChange).toHaveBeenLastCalledWith("ALL");
  });
});

describe("FilterBar", () => {
  it("renders the chip group as one menu in the same row as search", () => {
    render(
      <FilterBar
        search={{ label: "Search users", value: "", onChange: jest.fn() }}
        chips={{
          label: "Role",
          options: [{ value: "ADMIN", label: "Admin" }],
          value: "ADMIN",
          onChange: jest.fn(),
          clearable: true,
        }}
        onClear={jest.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search users" });
    const menu = screen.getByRole("button", { name: "Role: Admin" });
    expect(menu.closest(".flex-wrap")).toBe(search.closest(".flex-wrap"));
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });
});

describe("AppointmentsFilterBar", () => {
  function Harness() {
    const [type, setType] = useState<TypeFilter>("CONSULTATION");
    const [search, setSearch] = useState("anna");
    const [range, setRange] = useState<DateRange>({
      from: "2026-11-15",
      to: "2026-11-15",
    });
    return (
      <AppointmentsFilterBar
        typeFilter={type}
        onTypeChange={setType}
        search={search}
        onSearchChange={setSearch}
        dateRange={range}
        onDateRangeChange={setRange}
        zone={ZONE}
        dateDirection="future"
      />
    );
  }

  it("counts active filters and clears them all at once", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Clear (3)" }));
    expect(screen.queryByRole("button", { name: /^Clear \(/ })).toBeNull();
    expect(screen.getByRole("button", { name: "All types" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Date: Any date" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search appointments" }),
    ).toHaveValue("");
  });

  it("shows every type up front as a chip, with no menu to open", () => {
    render(<Harness />);
    const chips = within(screen.getByRole("group", { name: "Type" }));
    expect(
      chips.getAllByRole("button").map((chip) => chip.textContent),
    ).toEqual([
      "All types",
      "Consultations",
      "Subscriptions",
      "Trials",
      "Webinars",
      "Classes",
    ]);
    expect(screen.queryByRole("button", { name: /^Type:/ })).toBeNull();

    fireEvent.click(chips.getByRole("button", { name: "Webinars" }));
    expect(chips.getByRole("button", { name: "Webinars" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      chips.getByRole("button", { name: "Consultations" }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});

describe("an active filter menu", () => {
  it("keeps its trigger and clear button in one box, and clears", () => {
    const onChange = jest.fn();
    render(
      <FilterMenu
        label="Status"
        options={[{ value: "OPEN", label: "Open" }]}
        value="OPEN"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Status: Open" });
    const clear = screen.getByRole("button", { name: "Clear status filter" });
    expect(clear.parentElement).toBe(trigger.parentElement);
    fireEvent.click(clear);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("disables the trigger and the clear button together", () => {
    render(
      <FilterMenu
        label="Status"
        options={[{ value: "OPEN", label: "Open" }]}
        value="OPEN"
        onChange={jest.fn()}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Status: Open" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Clear status filter" }),
    ).toBeDisabled();
  });
});

describe("FilterMenu edge cases", () => {
  const options = [
    { value: "OPEN", label: "Open" },
    { value: "CLOSED", label: "Closed" },
  ];

  it("clears a clearable group when its current option is picked again", () => {
    const onChange = jest.fn();
    render(
      <FilterMenu
        label="Status"
        options={options}
        value="OPEN"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps a non-clearable group's pick when it is picked again", () => {
    const onChange = jest.fn();
    render(
      <FilterMenu
        label="Kind"
        options={[{ value: "all", label: "All" }, ...options]}
        value="OPEN"
        allValue="all"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Kind: Open" }));
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
    expect(onChange).toHaveBeenLastCalledWith("OPEN");
  });

  it("says Several, not All, when a non-clearable group holds a pick it cannot show", () => {
    const onChange = jest.fn();
    render(
      <FilterMenu
        label="Role"
        options={[{ value: "ALL", label: "All" }, ...options]}
        value={null}
        allValue="ALL"
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Role: Several" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear role filter" }));
    expect(onChange).toHaveBeenLastCalledWith("ALL");
  });
});

describe("FilterBar search", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps a typed trailing space when the caller stores the value trimmed", () => {
    function Harness() {
      const [q, setQ] = useState("");
      return (
        <FilterBar
          search={{
            label: "Search users",
            value: q,
            onChange: (v) => setQ(v.trim()),
          }}
        />
      );
    }
    render(<Harness />);
    const box = screen.getByRole("searchbox", { name: "Search users" });
    fireEvent.change(box, { target: { value: "John " } });
    act(() => jest.advanceTimersByTime(400));
    expect(box).toHaveValue("John ");
    fireEvent.change(box, { target: { value: "John Doe" } });
    act(() => jest.advanceTimersByTime(400));
    expect(box).toHaveValue("John Doe");
  });

  it("still replaces the typed text on an outside change such as Clear", () => {
    function Harness() {
      const [q, setQ] = useState("");
      return (
        <>
          <FilterBar
            search={{
              label: "Search users",
              value: q,
              onChange: (v) => setQ(v.trim()),
            }}
          />
          <button type="button" onClick={() => setQ("")}>
            Reset
          </button>
        </>
      );
    }
    render(<Harness />);
    const box = screen.getByRole("searchbox", { name: "Search users" });
    fireEvent.change(box, { target: { value: "John" } });
    act(() => jest.advanceTimersByTime(400));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(box).toHaveValue("");
  });
});

describe("menu popups", () => {
  it("are named for screen readers", () => {
    render(
      <FilterMenu
        label="Status"
        options={[]}
        value={null}
        onChange={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status: All" }));
    expect(screen.getByRole("dialog", { name: "Status" })).toBeInTheDocument();
  });
});
