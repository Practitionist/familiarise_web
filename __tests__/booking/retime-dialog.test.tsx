/**
 * The re-time picker offers only starts the server accepts, read in the
 * host's profile zone (a :45 zone included), and forgets a half-made pick
 * when it closes.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { timezone: "Asia/Kathmandu" } },
  }),
}));

import {
  RetimeDialog,
  retimeStartsOn,
} from "../../components/appointments/RetimeDialog";

describe("retimeStartsOn", () => {
  it("lists every UTC half-hour start of the day in a :45 zone", () => {
    const starts = retimeStartsOn(
      "2026-12-10",
      "Asia/Kathmandu",
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(starts).toHaveLength(48);
    for (const s of starts) {
      expect(new Date(s.iso).getTime() % 1_800_000).toBe(0);
    }
    // Kathmandu is UTC+5:45, so the UTC grid reads :15 and :45 locally.
    expect(starts[0].label).toMatch(/12:15/);
  });

  it("drops starts inside the 24-hour lead", () => {
    const now = new Date("2026-12-09T06:00:00Z");
    const starts = retimeStartsOn("2026-12-10", "UTC", now);
    expect(starts[0].iso).toBe("2026-12-10T06:00:00.000Z");
  });
});

describe("RetimeDialog", () => {
  const props = {
    onConfirm: jest.fn(async () => true),
    onCancel: jest.fn(),
    title: "Pitch clinic",
  };

  it("labels the profile zone and forgets the pick when closed", () => {
    const { rerender } = render(<RetimeDialog {...props} isOpen />);
    expect(screen.getByTestId("zone-switch").textContent).toMatch(
      /Times shown in/,
    );
    const day = screen.getByLabelText("New date");
    fireEvent.change(day, { target: { value: "2099-12-10" } });
    expect((day as HTMLInputElement).value).toBe("2099-12-10");

    fireEvent.click(screen.getByRole("button", { name: "Keep the date" }));
    expect(props.onCancel).toHaveBeenCalled();
    rerender(<RetimeDialog {...props} isOpen={false} />);
    rerender(<RetimeDialog {...props} isOpen />);
    expect((screen.getByLabelText("New date") as HTMLInputElement).value).toBe(
      "",
    );
  });
});
