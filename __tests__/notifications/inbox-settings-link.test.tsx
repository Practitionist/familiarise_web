/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: {
      user: { id: "user", role: "CONSULTANT", consultantProfileId: "expert" },
    },
  }),
}));
jest.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));
jest.mock("@/hooks/useNovuSubscriberSync", () => ({
  useNovuSubscriberSync: () => ({
    data: { success: true, subscriberHash: "a".repeat(64) },
    status: "success",
    refetch: jest.fn(),
  }),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@novu/nextjs", () => ({
  Inbox: ({ children }: { children: ReactNode }) => <>{children}</>,
  Bell: ({
    renderBell,
  }: {
    renderBell: (count: { total: number }) => ReactNode;
  }) => <>{renderBell({ total: 9 })}</>,
  Notifications: () => <div>Inbox feed</div>,
  InboxContent: () => {
    throw new Error("The independent preference editor must not be mounted");
  },
}));
const previousId = process.env.NEXT_PUBLIC_NOVU_APP_ID;
beforeAll(() => (process.env.NEXT_PUBLIC_NOVU_APP_ID = "app-test"));
afterAll(() => {
  if (previousId === undefined) delete process.env.NEXT_PUBLIC_NOVU_APP_ID;
  else process.env.NEXT_PUBLIC_NOVU_APP_ID = previousId;
});

it("keeps the unread feed and links to the user's canonical settings without the native editor", async () => {
  const { NotificationInbox } =
    await import("@/components/notifications/NotificationInbox");
  render(<NotificationInbox />);
  expect(
    screen.getByRole("status", { name: "9 unread notifications" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  expect(await screen.findByText("Inbox feed")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Notifications & emails" }),
  ).toHaveAttribute(
    "href",
    "/dashboard/consultant/expert/settings/notifications",
  );
});
