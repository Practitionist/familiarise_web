/**
 * The loading skeleton keeps the grid's geometry, so the page does not
 * shift when the data lands: the same columns, a 64px header, 24px rows,
 * and the session tray beside the grid.
 */
import React from "react";
import { render } from "@testing-library/react";

import { CalendarGridSkeleton } from "@/components/scheduling/CalendarSkeletons";
import { GRID_COLS } from "@/lib/scheduling/week-grid-geometry";

describe("CalendarGridSkeleton", () => {
  it("draws the grid's columns, header and row pitch, and the tray", () => {
    const { container } = render(<CalendarGridSkeleton />);
    const columns = Array.from(container.querySelectorAll("div")).filter(
      (element) => element.className.includes(GRID_COLS),
    );
    expect(columns[0].className).toContain("h-16");
    expect(columns.length).toBeGreaterThan(1);
    expect(columns[1].querySelector(".h-6")).not.toBeNull();
    expect(container.querySelector(".xl\\:w-80")).not.toBeNull();
  });
});
