/**
 * The heat map is a valid ARIA grid with one roving tab stop, and the
 * keyboard moves between cells, rows, days and weeks.
 */
import React, { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { WeekGrid, type GridFocus } from "@/components/scheduling/WeekGrid";
import { buildWeekCells } from "@/lib/scheduling/week-grid-model";
import { weekRowModel } from "@/lib/time/grid-zone";

const ZONE = "Asia/Kolkata";
const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 2, 8 + i, 12));
const rows = weekRowModel(days, ZONE);
const empty = new Set<number>();
const cells = buildWeekCells(rows, {
  serverCells: new Map(),
  eventStarts: empty,
  tentativeStarts: empty,
  selectedStarts: empty,
  justTakenStarts: empty,
  requestedStarts: empty,
  nowMs: 0,
});
// Three visible rows (9:00, 9:30, 10:00) to keep the test readable.
const VISIBLE_ROWS = { from: 18, to: 21 };

function Harness({
  onPageWeek,
}: Readonly<{ onPageWeek: (d: -1 | 1) => void }>) {
  const [focus, setFocus] = useState<GridFocus>({ rowKey: "", dayIndex: 0 });
  return (
    <WeekGrid
      days={days}
      axis={rows.axis}
      matrix={cells.matrix}
      rows={VISIBLE_ROWS}
      blocks={[]}
      todayIndex={-1}
      inPeriodDays={days.map(() => false)}
      nowAtomStartMs={0}
      nowFraction={0}
      focus={focus}
      zone={ZONE}
      readOnly={false}
      refreshing={false}
      tooltipOf={() => null}
      onActivate={() => {}}
      onFocusChange={setFocus}
      onPageWeek={onPageWeek}
      gridRef={() => {}}
      label="Available half-hour times"
    />
  );
}

function focusable(grid: HTMLElement) {
  return within(grid)
    .getAllByRole("button")
    .filter((button) => button.tabIndex === 0);
}

function cellAt(grid: HTMLElement, rowIndex: number, dayIndex: number) {
  const row = within(grid).getAllByRole("row")[rowIndex + 1];
  return within(row).getAllByRole("button")[dayIndex];
}

describe("WeekGrid ARIA structure", () => {
  it("is grid > row > columnheader / rowheader / gridcell, header row inside the grid", () => {
    render(<Harness onPageWeek={() => {}} />);
    const grid = screen.getByRole("grid", {
      name: "Available half-hour times",
    });
    const allRows = within(grid).getAllByRole("row");
    expect(allRows).toHaveLength(4);
    expect(within(allRows[0]).getAllByRole("columnheader")).toHaveLength(8);
    for (const row of allRows.slice(1)) {
      expect(within(row).getAllByRole("rowheader")).toHaveLength(1);
      expect(within(row).getAllByRole("gridcell")).toHaveLength(7);
    }
    // Every direct child of the grid is a row.
    for (const child of Array.from(grid.children)) {
      expect(child.getAttribute("role")).toBe("row");
    }
    expect(grid).toHaveAttribute("aria-describedby");
  });

  it("has exactly one tab stop", () => {
    render(<Harness onPageWeek={() => {}} />);
    const grid = screen.getByRole("grid");
    expect(focusable(grid)).toHaveLength(1);
  });
});

describe("WeekGrid keyboard", () => {
  it("moves with arrows, Home/End and Ctrl+Home/End, carrying the tab stop", () => {
    render(<Harness onPageWeek={() => {}} />);
    const grid = screen.getByRole("grid");
    const start = cellAt(grid, 0, 0);
    act(() => start.focus());

    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cellAt(grid, 0, 1));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cellAt(grid, 1, 1));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement).toBe(cellAt(grid, 1, 6));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(cellAt(grid, 1, 0));
    fireEvent.keyDown(document.activeElement as Element, {
      key: "End",
      ctrlKey: true,
    });
    expect(document.activeElement).toBe(cellAt(grid, 2, 6));
    fireEvent.keyDown(document.activeElement as Element, {
      key: "Home",
      ctrlKey: true,
    });
    expect(document.activeElement).toBe(cellAt(grid, 0, 0));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(cellAt(grid, 0, 0));

    expect(focusable(grid)).toEqual([cellAt(grid, 0, 0)]);
  });

  it("pages weeks with PageUp/PageDown", () => {
    const onPageWeek = jest.fn();
    render(<Harness onPageWeek={onPageWeek} />);
    const grid = screen.getByRole("grid");
    const cell = cellAt(grid, 1, 3);
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: "PageDown" });
    fireEvent.keyDown(cell, { key: "PageUp" });
    expect(onPageWeek.mock.calls).toEqual([[1], [-1]]);
  });

  it("names every cell in plain words, with its state and time", () => {
    render(<Harness onPageWeek={() => {}} />);
    const grid = screen.getByRole("grid");
    const label = cellAt(grid, 0, 0).getAttribute("aria-label") ?? "";
    expect(label).toMatch(/^Unavailable · Sun,? 8 Mar, 9:00/);
    expect(label).not.toMatch(/slot/i);
    expect(cellAt(grid, 0, 0)).toHaveAttribute("aria-disabled", "true");
  });
});

describe("WeekGrid canvas", () => {
  it("draws cells edge to edge on 24px rows, with closed time hatched on the canvas", () => {
    render(<Harness onPageWeek={() => {}} />);
    const grid = screen.getByRole("grid");
    const cell = cellAt(grid, 0, 0);
    expect(cell.className).toContain("h-6");
    expect(cell.className).not.toMatch(/\brounded-sm\b|\bh-7\b/);
    // Closed time paints on the gridcell, so the unavailable token stays paint-free.
    expect(cell.closest("[role='gridcell']")?.className).toContain(
      "repeating-linear-gradient(135deg",
    );
    expect(within(grid).getAllByRole("row")[1].className).not.toMatch(/gap-/);
  });
});
