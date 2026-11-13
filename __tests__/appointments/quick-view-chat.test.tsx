/**
 * Chat actions carry a chat target, a class or webinar DM follows the event's
 * openable states, and the list quick view opens the
 * chat sheet instead of linking to Messages.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type { OverflowItem } from "@/lib/appointments/adapter";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import {
  chatAffordancesForVm,
  messageLabel,
} from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { AppointmentSheet } from "@/components/appointments/AppointmentSheet";

const classVm = {
  id: "class-c1",
  appointmentId: "apt-1",
  kind: "CLASS",
  title: "Algebra 101",
  counterpart: { name: "Asha", image: null },
  consultantProfileId: "cp-1",
  status: "SCHEDULED",
  bucket: "upcoming",
  needsActionReason: null,
  nextAt: null,
  occurrences: [],
  group: null,
  meta: null,
  organizationId: null,
  pendingPaymentUrl: null,
  collaborators: [],
  collaboratorRole: null,
  raw: {
    appointment: {
      classId: "c1",
      class: {
        id: "c1",
        classPlan: {
          consultantProfile: { user: { id: "host-u", name: "Liam Anderson" } },
        },
      },
    },
  },
} as unknown as AppointmentVM;

const affordances = () =>
  chatAffordancesForVm({
    vm: classVm,
    messagesBasePath: "/dashboard/consultee/ce-1/messages",
    role: "consultee",
    push: mockPush,
  });

it("offers class chat and the host DM for an in-progress class, both as chat targets", () => {
  const items = affordances();
  expect(items.map((i) => [i.label, i.chat?.kind])).toEqual([
    ["Class chat", "event"],
    ["Message Liam Anderson", "dm"],
  ]);
  expect(items[1].chat).toMatchObject({
    counterpartyUserId: "host-u",
    appointmentId: "apt-1",
    messagesHref:
      "/dashboard/consultee/ce-1/messages?contextAppointmentId=apt-1&counterpartyUserId=host-u",
  });
});

it("opens the chat sheet from the quick view instead of navigating", () => {
  const items: OverflowItem[] = affordances();
  const onOpenChat = jest.fn();
  render(
    <AppointmentSheet
      vm={classVm}
      onOpenChange={jest.fn()}
      onOpenChat={onOpenChat}
      adapter={{
        role: "consultee",
        detailHref: () => null,
        primaryAction: () => ({ kind: "view", label: "View" }),
        overflowItems: () => items,
        renderDialogs: () => null,
      }}
    />,
  );

  expect(screen.queryByRole("link", { name: "Class chat" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Class chat" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Message Liam Anderson" }),
  );

  expect(onOpenChat.mock.calls.map(([t]) => t.kind)).toEqual(["event", "dm"]);
  expect(onOpenChat.mock.calls[0][0]).toMatchObject({
    eventType: "class",
    eventId: "c1",
  });
  expect(mockPush).not.toHaveBeenCalled();
});

it("names the other person on the DM action, falling back to the role", () => {
  expect(affordances()[1].chat?.title).toBe("Message Liam Anderson");
  expect(messageLabel("  Priya ", "consultant")).toBe("Message Priya");
  expect(messageLabel(null, "consultee")).toBe("Message Consultant");
  expect(messageLabel(" ", "consultant")).toBe("Message Consultee");
});
