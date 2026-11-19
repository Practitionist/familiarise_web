/**
 * An availability save never moves a booking: the bookings it would leave
 * outside the new hours are listed before the save with no way off the page,
 * and offered for reschedule or cancel only once the hours are saved.
 */
import * as React from "react";
import fs from "fs";
import path from "path";
import { act, fireEvent, render, screen } from "@testing-library/react";

// The desktop dialog, not the mobile sheet.
jest.mock("../../hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));
jest.mock("../../lib/time/use-viewer-zone", () => ({
  useViewerZone: () => ({ zone: "Asia/Kolkata", own: true }),
}));

import {
  AvailabilitySaveConfirm,
  outsideHoursLinks,
} from "../../app/dashboard/consultant/[consultantId]/(features)/settings/AvailabilitySaveConfirm";
import type { AvailabilitySavePreview } from "../../app/dashboard/consultant/[consultantId]/(features)/settings/use-consultant-settings-form";

const session = (id: string) => ({
  appointmentId: id,
  startsAt: "2099-12-10T06:00:00.000Z",
  held: false,
});

/** The settings form's half: it keeps the preview and marks it saved. */
function Harness({
  preview,
  save,
}: Readonly<{
  preview: AvailabilitySavePreview;
  save: () => Promise<void>;
}>) {
  const [state, setState] = React.useState<{ saved: boolean } | null>({
    saved: false,
  });
  return (
    <AvailabilitySaveConfirm
      consultantId="cp-1"
      preview={state ? preview : null}
      saved={state?.saved ?? false}
      onConfirm={async () => {
        await save();
        setState({ saved: true });
      }}
      onClose={() => setState(null)}
    />
  );
}

const links = () => screen.queryAllByRole("link");

describe("AvailabilitySaveConfirm", () => {
  it("lists the bookings with no link before the save, and links them once it is saved", async () => {
    render(
      <Harness
        preview={{
          sessions: [session("a-1"), session("a-2"), session("a-3")],
          customDatesRemoved: 0,
        }}
        save={async () => undefined}
      />,
    );
    expect(screen.getByText("Save these hours?")).toBeTruthy();
    expect(
      screen.getByText(
        "These 3 bookings would fall outside your new hours. They keep their times.",
      ),
    ).toBeTruthy();
    expect(links()).toHaveLength(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    });
    expect(screen.getByText("Hours saved")).toBeTruthy();
    expect(
      screen.getByText(
        "3 bookings are outside your new hours. Reschedule or cancel any you can't make.",
      ),
    ).toBeTruthy();
    expect(links()).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Hours saved")).toBeNull();
  });

  it("a failed save keeps asking, with the reason and no links", async () => {
    render(
      <Harness
        preview={{ sessions: [session("a-1")], customDatesRemoved: 2 }}
        save={async () => {
          throw new Error("Failed to update settings. Please try again.");
        }}
      />,
    );
    expect(
      screen.getByText(
        "This booking would fall outside your new hours. It keeps its time.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Saving weekly hours removes your 2 upcoming custom dates.",
      ),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Failed to update settings. Please try again.",
    );
    expect(screen.getByText("Save these hours?")).toBeTruthy();
    expect(links()).toHaveLength(0);
  });

  it("says one booking in the singular once saved", async () => {
    render(
      <Harness
        preview={{ sessions: [session("a-1")], customDatesRemoved: 0 }}
        save={async () => undefined}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    });
    expect(
      screen.getByText(
        "1 booking is outside your new hours. Reschedule or cancel it if you can't make it.",
      ),
    ).toBeTruthy();
  });

  it("dismisses with Keep editing, and names the booking a row's cancel link cancels", async () => {
    render(
      <Harness
        preview={{ sessions: [session("a-1")], customDatesRemoved: 0 }}
        save={async () => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    });
    expect(links().map((l) => l.textContent)).toEqual([
      "Reschedule",
      "Cancel booking",
    ]);
  });

  it("links to the expert's existing reschedule and booking pages", () => {
    const { reschedule, cancel } = outsideHoursLinks("cp-1", "a-1");
    const page = (href: string) =>
      path.join(
        process.cwd(),
        "app",
        href
          .replace("/cp-1/", "/[consultantId]/(features)/")
          .replace("/a-1", "/[appointmentId]"),
        "page.tsx",
      );
    expect(reschedule).toBe(
      "/dashboard/consultant/cp-1/appointments/a-1/reschedule",
    );
    expect(fs.existsSync(page(reschedule))).toBe(true);
    expect(fs.existsSync(page(cancel))).toBe(true);
  });
});
