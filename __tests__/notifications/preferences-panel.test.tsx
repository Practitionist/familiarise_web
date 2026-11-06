/**
 * The notification settings panel: labelled switches, an optimistic save that
 * rolls back on failure, a per-control pending lock, role-filtered categories
 * and the workspace-routing message.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type SessionUser = {
  id: string;
  role?: string;
  consultantProfileId?: string;
  organizationMemberships?: { organizationName: string }[];
};

let mockUser: SessionUser = { id: "u1", role: "CONSULTEE" };
const mockToast = jest.fn();
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: mockUser } }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { NotificationPreferencesPanel } from "@/components/notifications/NotificationPreferencesPanel";

let putResponse: () => Promise<Partial<Response>>;
let stored: Record<string, unknown>;

beforeEach(() => {
  mockUser = { id: "u1", role: "CONSULTEE" };
  stored = {};
  putResponse = async () => ({ ok: true, json: async () => stored });
  global.fetch = jest.fn((_url: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? putResponse()
      : Promise.resolve({ ok: true, json: async () => stored }),
  ) as unknown as typeof fetch;
});

function renderPanel(
  props: React.ComponentProps<typeof NotificationPreferencesPanel> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NotificationPreferencesPanel {...props} />
    </QueryClientProvider>,
  );
}

it("labels every switch and disables, not hides, children when optional notifications are off", async () => {
  stored = { allNotifications: false };
  renderPanel();
  const master = await screen.findByRole("switch", {
    name: "Optional notifications",
  });
  expect(master).toBeEnabled();
  expect(screen.getByLabelText("Email notifications")).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Support Cases" })).toBeDisabled();
  expect(screen.queryByText(/push/i)).toBeNull();
});

it("saves optimistically, locks only the pending switch, and rolls back on a 500", async () => {
  let fail: (res: Partial<Response>) => void = () => {};
  putResponse = () => new Promise((resolve) => (fail = resolve));
  renderPanel();

  const email = await screen.findByRole("switch", {
    name: "Email notifications",
  });
  expect(email).toBeChecked();
  fireEvent.click(email);

  await waitFor(() => expect(email).not.toBeChecked());
  expect(email).toBeDisabled();
  expect(
    screen.getByRole("switch", { name: "In-app notifications" }),
  ).toBeEnabled();

  fail({ ok: false, status: 500, json: async () => ({}) });

  await waitFor(() => expect(email).toBeChecked());
  expect(email).toBeEnabled();
  expect(mockToast).toHaveBeenCalledWith(
    expect.objectContaining({ variant: "destructive" }),
  );
});

it.each([
  [
    "consultee",
    { role: "CONSULTEE" },
    ["Bookings & sessions"],
    ["Hold planning reminders", "Billing & payouts"],
  ],
  [
    "consultant",
    { role: "CONSULTANT", consultantProfileId: "cp1" },
    ["Bookings & sessions", "Hold planning reminders"],
    ["Billing & payouts"],
  ],
  [
    "org operator",
    {
      role: "ORG_WORKSPACE",
      organizationMemberships: [{ organizationName: "Acme" }],
    },
    ["Support Cases", "Billing & payouts"],
    ["Bookings & sessions", "Trial sessions", "Hold planning reminders"],
  ],
])(
  "shows a %s only the categories it can receive",
  async (_who, user, shown, hidden) => {
    mockUser = { id: "u1", ...user };
    renderPanel();
    for (const name of shown) {
      expect(await screen.findByRole("switch", { name })).toBeInTheDocument();
    }
    for (const name of hidden) {
      expect(screen.queryByRole("switch", { name })).toBeNull();
    }
  },
);

it("says when workspace routing overrides a personal channel", async () => {
  mockUser = { id: "u1", role: "ORG_WORKSPACE" };
  renderPanel({ routing: { mode: "BELL_ONLY", label: "Bell only" } });
  expect(
    await screen.findByText(
      "Email is off because this workspace's routing is Bell only.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/In-app notifications are off/)).toBeNull();
});
