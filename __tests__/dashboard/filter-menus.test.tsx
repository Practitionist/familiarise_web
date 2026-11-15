import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { AppointmentsFilterBar } from "@/components/appointments/AppointmentsFilterBar";
import type { TypeFilter } from "@/components/appointments/AppointmentsFilterBar";
import {
  datePresets,
  dateRangeLabel,
  type DateRange,
} from "@/components/dashboard/DateRangeMenu";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { FilterMenu } from "@/components/dashboard/FilterMenu";

// Sunday 15 Nov 2026, local time.
const NOW = new Date(2026, 10, 15, 10, 0);

describe("datePresets", () => {
  it("looks forward on to-do tabs, with the week running Monday to Sunday", () => {
    const presets = datePresets("future", NOW);
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
  });

  it("looks back on done tabs", () => {
    const presets = datePresets("past", NOW);
    expect(presets.map((p) => p.label)).toEqual([
      "Today",
      "Last 7 days",
      "Last 30 days",
      "This month",
      "Last 3 months",
    ]);
    expect(presets[3].range).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });
});

describe("dateRangeLabel", () => {
  const presets = datePresets("future", NOW);
  it.each<[DateRange, string]>([
    [{ from: "", to: "" }, "Any date"],
    [{ from: "2026-11-15", to: "2026-11-22" }, "Next 7 days"],
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
        dateDirection="future"
      />
    );
  }

  it("counts active filters and clears them all at once", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Clear (3)" }));
    expect(screen.queryByRole("button", { name: /^Clear \(/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Type: All" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Date: Any date" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search appointments" }),
    ).toHaveValue("");
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
