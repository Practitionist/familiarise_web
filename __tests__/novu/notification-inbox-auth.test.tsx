import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

const mockSync = jest.fn();
const mockRefetch = jest.fn();
let mockUnread = 0;

jest.mock("@novu/nextjs", () => ({
  Inbox: ({
    subscriberHash,
    children,
  }: {
    subscriberHash?: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="novu-inbox" data-hash={subscriberHash}>
      {children}
    </div>
  ),
  Bell: ({
    renderBell,
  }: {
    renderBell?: (unread: { total: number }) => React.ReactNode;
  }) => <span>{renderBell?.({ total: mockUnread })}</span>,
  InboxContent: () => <div />,
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));
jest.mock("../../hooks/useNovuSubscriberSync", () => ({
  useNovuSubscriberSync: () => ({ ...mockSync(), refetch: mockRefetch }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let NotificationInbox: typeof import("../../components/notifications/NotificationInbox").NotificationInbox;

beforeAll(async () => {
  // Read at module load, so it must be set before the import.
  process.env.NEXT_PUBLIC_NOVU_APP_ID = "novu-app";
  ({ NotificationInbox } =
    await import("../../components/notifications/NotificationInbox"));
});

beforeEach(() => {
  mockUnread = 0;
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_NOVU_APP_ID;
});

describe("NotificationInbox signed sessions", () => {
  it("mounts Novu with the server-issued hash", () => {
    const subscriberHash = "a".repeat(64);
    mockSync.mockReturnValue({
      status: "success",
      data: { success: true, subscriberHash },
    });

    render(<NotificationInbox />);

    expect(screen.getByTestId("novu-inbox")).toHaveAttribute(
      "data-hash",
      subscriberHash,
    );
  });

  it("keeps Novu unmounted and offers a retry when the sync failed", () => {
    mockSync.mockReturnValue({ status: "error", data: undefined });

    render(<NotificationInbox />);

    expect(screen.queryByTestId("novu-inbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications unavailable. Retry" }),
    );
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it("never opens an unsigned session when the response has no hash", () => {
    mockSync.mockReturnValue({ status: "success", data: { success: true } });

    render(<NotificationInbox />);

    expect(screen.queryByTestId("novu-inbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Notifications unavailable. Retry" }),
    ).toBeEnabled();
  });

  it("shows a disabled loading bell while the sync is pending", () => {
    mockSync.mockReturnValue({ status: "pending", data: undefined });

    render(<NotificationInbox />);

    expect(screen.queryByTestId("novu-inbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Loading notifications" }),
    ).toBeDisabled();
  });

  it("names the trigger with the unread count and hides the badge from assistive tech", () => {
    mockSync.mockReturnValue({
      status: "success",
      data: { success: true, subscriberHash: "a".repeat(64) },
    });
    mockUnread = 3;

    render(<NotificationInbox />);

    const trigger = screen.getByRole("button", {
      name: "Notifications, 3 unread",
    });
    expect(trigger.querySelector("span[aria-hidden='true']")?.textContent).toBe(
      "3",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the plain name when nothing is unread", () => {
    mockSync.mockReturnValue({
      status: "success",
      data: { success: true, subscriberHash: "a".repeat(64) },
    });

    render(<NotificationInbox />);

    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });
});
