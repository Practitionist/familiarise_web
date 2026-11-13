/**
 * The re-time dialog picks the new start on the host's own calendar with the
 * 24-hour rule, and forgets a half-made pick when it closes.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("../../lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kathmandu", own: true }),
}));

const pickerProps: Array<Record<string, unknown>> = [];
jest.mock("../../components/scheduling/SingleTimePicker", () => ({
  SingleTimePicker: (props: {
    onChange: (value: { startsAt: string; endsAt: string } | null) => void;
  }) => {
    pickerProps.push(props);
    return (
      <button
        type="button"
        onClick={() =>
          props.onChange({
            startsAt: "2099-12-10T06:00:00.000Z",
            endsAt: "2099-12-10T07:30:00.000Z",
          })
        }
      >
        pick a time
      </button>
    );
  },
}));

import { RetimeDialog } from "../../components/appointments/RetimeDialog";

describe("RetimeDialog", () => {
  const props = {
    onConfirm: jest.fn(async () => true),
    onCancel: jest.fn(),
    title: "Pitch clinic",
    consultantId: "profile-1",
    sessionMinutes: 90,
  };

  beforeEach(() => {
    pickerProps.length = 0;
    jest.clearAllMocks();
  });

  it("asks the picker for a re-time on the host's calendar in their zone", () => {
    render(<RetimeDialog {...props} isOpen />);
    expect(pickerProps.at(-1)).toMatchObject({
      consultantId: "profile-1",
      zone: "Asia/Kathmandu",
      sessionMinutes: 90,
      purpose: "retime",
      audience: "host",
      theme: "light",
      value: null,
    });
    expect(screen.getByRole("button", { name: "Move webinar" })).toBeDisabled();
  });

  it("moves to the picked start", () => {
    render(<RetimeDialog {...props} isOpen />);
    fireEvent.click(screen.getByRole("button", { name: "pick a time" }));
    fireEvent.click(screen.getByRole("button", { name: "Move webinar" }));
    expect(props.onConfirm).toHaveBeenCalledWith("2099-12-10T06:00:00.000Z");
  });

  it("forgets the pick when closed", () => {
    const { rerender } = render(<RetimeDialog {...props} isOpen />);
    fireEvent.click(screen.getByRole("button", { name: "pick a time" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep the date" }));
    expect(props.onCancel).toHaveBeenCalled();
    rerender(<RetimeDialog {...props} isOpen={false} />);
    rerender(<RetimeDialog {...props} isOpen />);
    expect(pickerProps.at(-1)).toMatchObject({ value: null });
  });
});
