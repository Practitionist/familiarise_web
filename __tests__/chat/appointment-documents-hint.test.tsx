/**
 * The appointment documents hint is scoped to the conversation the appointment
 * context opened: it needs both the URL param and a matching booking-context
 * receipt in the loaded messages, so a stale param or an unrelated chat shows
 * nothing. It re-derives from the channel-state context on every render.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

type Receipt = {
  id: string;
  booking_appointment_id?: string;
  custom?: Record<string, unknown>;
};

let searchParams: URLSearchParams | null;
let channelState: {
  channel: { state?: { messages?: Receipt[] } };
  messages?: Receipt[];
};

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));
jest.mock("stream-chat-react", () => ({
  useChannelStateContext: () => channelState,
}));

import { AppointmentDocumentsHint } from "@/components/chat/AppointmentDocumentsHint";

function receipt(appointmentId: string): Receipt {
  return { id: "booking-ctx-1", booking_appointment_id: appointmentId };
}

function setChannel(messages?: Receipt[], fallback?: Receipt[]) {
  channelState = { channel: { state: { messages: fallback } }, messages };
}

describe("AppointmentDocumentsHint", () => {
  it("renders nothing without an appointment param", () => {
    searchParams = new URLSearchParams();
    setChannel([receipt("apt-1")]);
    const { container } = render(<AppointmentDocumentsHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the param has no matching receipt", () => {
    searchParams = new URLSearchParams({ contextAppointmentId: "apt-2" });
    setChannel([receipt("apt-1")]);
    const { container } = render(<AppointmentDocumentsHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the hint and documents link for the matching conversation", () => {
    searchParams = new URLSearchParams({ contextAppointmentId: "apt-1" });
    setChannel([receipt("apt-1")]);
    render(<AppointmentDocumentsHint />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Share files under Documents for this session",
    );
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/dashboard/go/auto/appointments/apt-1/documents",
    );
  });

  it("reads the receipt from message.custom too", () => {
    searchParams = new URLSearchParams({ contextAppointmentId: "apt-1" });
    setChannel([{ id: "m1", custom: { booking_appointment_id: "apt-1" } }]);
    render(<AppointmentDocumentsHint />);
    expect(
      screen.getByTestId("appointment-documents-hint"),
    ).toBeInTheDocument();
  });

  it("falls back to channel.state.messages when the context has none", () => {
    searchParams = new URLSearchParams({ contextAppointmentId: "apt-1" });
    setChannel(undefined, [receipt("apt-1")]);
    render(<AppointmentDocumentsHint />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("accepts the appointmentId alias, with contextAppointmentId first", () => {
    searchParams = new URLSearchParams({ appointmentId: "apt-1" });
    setChannel([receipt("apt-1")]);
    const { rerender } = render(<AppointmentDocumentsHint />);
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/dashboard/go/auto/appointments/apt-1/documents",
    );

    searchParams = new URLSearchParams({
      contextAppointmentId: "apt-1",
      appointmentId: "apt-2",
    });
    rerender(<AppointmentDocumentsHint />);
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/dashboard/go/auto/appointments/apt-1/documents",
    );
  });

  it("ignores an empty contextAppointmentId and uses the alias", () => {
    searchParams = new URLSearchParams({
      contextAppointmentId: "",
      appointmentId: "apt-1",
    });
    setChannel([receipt("apt-1")]);
    render(<AppointmentDocumentsHint />);
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/dashboard/go/auto/appointments/apt-1/documents",
    );
  });

  it("renders nothing when the loaded channel has no messages", () => {
    searchParams = new URLSearchParams({ contextAppointmentId: "apt-1" });
    channelState = { channel: { state: {} } };
    const { container } = render(<AppointmentDocumentsHint />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides again when the channel switches to another conversation", () => {
    searchParams = new URLSearchParams({ contextAppointmentId: "apt-1" });
    setChannel([receipt("apt-1")]);
    const { rerender } = render(<AppointmentDocumentsHint />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    setChannel([receipt("apt-9")]);
    rerender(<AppointmentDocumentsHint />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
