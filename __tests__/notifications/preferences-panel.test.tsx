/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { NotificationPreferenceSchema } from "@/schemas/user";
let mockPreferences:
  ReturnType<typeof NotificationPreferenceSchema.parse> | undefined;
let mockSessionPending = false;
const mockMutate = jest.fn();
beforeEach(() => {
  mockPreferences = NotificationPreferenceSchema.parse({});
  mockSessionPending = false;
  mockMutate.mockClear();
});
jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: string[] }) => ({
    data:
      options.queryKey[0] === "inbox-preferences"
        ? { globalMuted: false, workflows: [] }
        : mockPreferences,
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({ mutate: mockMutate }),
  useQueryClient: () => ({ setQueryData: jest.fn() }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user" } },
    isPending: mockSessionPending,
  }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
import { NotificationPreferencesPanel } from "@/components/notifications/NotificationPreferencesPanel";

it("persists the displayed default schedule when enabling quiet hours", () => {
  render(<NotificationPreferencesPanel />);
  const label = screen.getByText("Enable Quiet Hours");
  const container = label.parentElement?.parentElement;
  const toggle = container?.querySelector('[role="switch"]');
  if (!toggle) throw new Error("Quiet hours toggle missing");
  fireEvent.click(toggle);
  expect(mockMutate).toHaveBeenCalledWith({
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    quietHoursTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

it("keeps saved delivery choices visible and marketing consent editable when paused", () => {
  mockPreferences = NotificationPreferenceSchema.parse({
    allNotifications: false,
  });
  render(<NotificationPreferencesPanel />);
  expect(screen.getByText("Channels")).toBeInTheDocument();
  expect(screen.getByLabelText("In-App Notifications")).toBeDisabled();
  const marketing = screen.getByLabelText("Products and offers");
  expect(marketing).toBeEnabled();
  fireEvent.click(marketing);
  expect(mockMutate).toHaveBeenCalledWith({ marketingEmails: true });
  expect(screen.getByText(/Marketing delivery is paused/)).toBeInTheDocument();
  expect(
    screen.getByText(
      /Required emails still arrive, including account access and security/,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Push Notifications")).not.toBeInTheDocument();
});

it("does not offer default consent controls while account identity is unresolved", () => {
  mockSessionPending = true;
  render(<NotificationPreferencesPanel />);
  expect(
    screen.queryByLabelText("Products and offers"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Allow optional notifications & emails"),
  ).not.toBeInTheDocument();
});
