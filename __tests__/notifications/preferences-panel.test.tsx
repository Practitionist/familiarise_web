/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
const mockMutate = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
  useMutation: () => ({ mutate: mockMutate }),
  useQueryClient: () => ({ setQueryData: jest.fn() }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user" } } }),
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
