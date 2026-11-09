/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RemoveParticipantDialog } from "@/components/events/RemoveParticipantDialog";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  // Radix radio and select size themselves with a ResizeObserver.
  globalThis.ResizeObserver = NoopResizeObserver;
  // ResponsiveModal picks a dialog or a sheet from a media query.
  window.matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
});

function setup(over: {
  allowNoFault: boolean;
  onSubmit?: jest.Mock<Promise<void>, [unknown]>;
}) {
  const onSubmit = over.onSubmit ?? jest.fn(async (_choice: unknown) => {});
  const onOpenChange = jest.fn();
  render(
    <RemoveParticipantDialog
      open
      onOpenChange={onOpenChange}
      attendeeName="Asha"
      eventTitle="Intro to SIPs"
      allowNoFault={over.allowNoFault}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onOpenChange };
}

describe("RemoveParticipantDialog on the roster (no-fault allowed)", () => {
  it("defaults to the no-fault refund, the pre-existing behavior", async () => {
    const { onSubmit, onOpenChange } = setup({ allowNoFault: true });
    expect(screen.getByText("Remove Asha?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove and refund" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ mode: "NO_FAULT" }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("holds the submit until a conduct reason is chosen", () => {
    setup({ allowNoFault: true });
    fireEvent.click(screen.getByLabelText(/Remove for conduct/));
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(
      screen.getByText(/will see this reason and note/),
    ).toBeInTheDocument();
  });
});

describe("RemoveParticipantDialog in the live room (conduct only)", () => {
  it("offers no refund shortcut and needs a reason", () => {
    setup({ allowNoFault: false });
    expect(screen.queryByLabelText(/Remove with a full refund/)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });
});

describe("RemoveParticipantDialog failures", () => {
  it("keeps the dialog open and shows the server's sentence", async () => {
    const onSubmit = jest.fn(async (_choice: unknown) => {
      throw new Error("Only a host or co-host can remove attendees.");
    });
    const { onOpenChange } = setup({ allowNoFault: true, onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Remove and refund" }));
    expect(
      await screen.findByText("Only a host or co-host can remove attendees."),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("falls back to a generic message for a nameless failure", async () => {
    const onSubmit = jest.fn(async (_choice: unknown) => {
      throw new Error("");
    });
    setup({ allowNoFault: true, onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Remove and refund" }));
    expect(
      await screen.findByText("That didn't go through. Please try again."),
    ).toBeInTheDocument();
  });
});
