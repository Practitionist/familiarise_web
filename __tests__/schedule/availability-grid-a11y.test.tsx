/**
 * The availability editor's rows: each time input is named for its day, end
 * and slot, an invalid row points its inputs at the error text, and a time the
 * half-hour grid moved says so in one line.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

import { AvailabilityGrid } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/sections/AvailabilityGrid";
import { SettingsSaveBar } from "@/components/dashboard/SettingsLayout";
import { gridSnapNotice } from "@/utils/schedule/formatting";

const noop = () => undefined;

function renderGrid() {
  return render(
    <AvailabilityGrid
      dayKey="monday"
      label="Monday"
      slots={[
        { startTime: "09:00", endTime: "10:00", isValid: true },
        {
          startTime: "11:00",
          endTime: "11:15",
          isValid: false,
          errorMessage: "A slot must be at least 30 minutes",
        },
        {
          startTime: "13:30",
          endTime: "14:30",
          isValid: true,
          snapNotice: gridSnapNotice(
            { startTime: "13:15", endTime: "14:15" },
            { startTime: "13:30", endTime: "14:30" },
          ),
        },
      ]}
      onAddSlot={noop}
      onUpdateSlot={noop}
      onDeleteSlot={noop}
    />,
  );
}

describe("AvailabilityGrid", () => {
  it("names every time input by day, end and slot", () => {
    renderGrid();
    expect(screen.getByLabelText("Monday start, slot 1")).toHaveValue("09:00");
    expect(screen.getByLabelText("Monday end, slot 1")).toHaveValue("10:00");
    expect(screen.getByLabelText("Monday start, slot 2")).toHaveValue("11:00");
  });

  it("marks an invalid row and points both inputs at its error", () => {
    renderGrid();
    const valid = screen.getByLabelText("Monday start, slot 1");
    expect(valid).toHaveAttribute("aria-invalid", "false");
    for (const name of ["Monday start, slot 2", "Monday end, slot 2"]) {
      const input = screen.getByLabelText(name);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription(
        "A slot must be at least 30 minutes",
      );
    }
  });

  it("says in one line when the half-hour grid moved a time", () => {
    renderGrid();
    expect(
      screen.getByText(
        "Moved to 13:30–14:30 so it starts on the half-hour booking grid.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Monday start, slot 3"),
    ).toHaveAccessibleDescription(
      "Moved to 13:30–14:30 so it starts on the half-hour booking grid.",
    );
  });

  it("says nothing when the grid left the time alone", () => {
    expect(
      gridSnapNotice(
        { startTime: "09:00", endTime: "10:00" },
        { startTime: "09:00", endTime: "10:00" },
      ),
    ).toBeUndefined();
  });
});

describe("SettingsSaveBar with a save blocker", () => {
  it("disables Save and says why", () => {
    render(
      <form>
        <SettingsSaveBar
          isSaving={false}
          onReset={noop}
          saveBlockedReason="Fix the time marked in red before saving."
        />
      </form>,
    );
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(
      "Fix the time marked in red before saving.",
    );
  });

  it("leaves Save enabled with no blocker", () => {
    render(<SettingsSaveBar isSaving={false} onReset={noop} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
