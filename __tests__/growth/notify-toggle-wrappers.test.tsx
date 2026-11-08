import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const refresh = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh }),
  usePathname: () => "/explore/x",
  useSearchParams: () => new URLSearchParams("a=1"),
}));
const toast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { NotifyMeButton } from "@/components/booking/NotifyMeButton";
import { NotifyWhenFreeButton } from "@/components/booking/NotifyWhenFreeButton";

let calls: { url: string; method: string; body?: string }[] = [];
function mockFetch(status = 200, body: unknown = {}) {
  calls = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body as string,
    });
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as typeof fetch;
}
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

beforeEach(() => {
  refresh.mockClear();
  toast.mockClear();
});

describe("NotifyMeButton", () => {
  it("links signed-out viewers to sign in with a return path", () => {
    wrap(
      <NotifyMeButton
        kind="WEBINAR"
        eventId="e1"
        waiting={false}
        signedIn={false}
      />,
    );
    const link = screen.getByText("Sign in to be notified").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/auth/signin?callbackUrl=" + encodeURIComponent("/explore/x?a=1"),
    );
  });

  it("POSTs to join and refreshes", async () => {
    mockFetch();
    wrap(<NotifyMeButton kind="CLASS" eventId="e1" waiting={false} signedIn />);
    fireEvent.click(screen.getByText("Notify me when a seat opens"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: "/api/scheduling/event-waitlist",
      method: "POST",
    });
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
      kind: "CLASS",
      eventId: "e1",
    });
  });

  it("DELETEs to leave", async () => {
    mockFetch();
    wrap(<NotifyMeButton kind="WEBINAR" eventId="e1" waiting signedIn />);
    fireEvent.click(screen.getByText("You're on the list · Leave"));
    await waitFor(() => expect(calls[0]?.method).toBe("DELETE"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({ title: "You left the waitlist" }),
    );
  });

  it("toasts the server's refusal", async () => {
    mockFetch(409, { error: "Waitlist is full" });
    wrap(
      <NotifyMeButton kind="WEBINAR" eventId="e1" waiting={false} signedIn />,
    );
    fireEvent.click(screen.getByText("Notify me when a seat opens"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Waitlist is full",
          variant: "destructive",
        }),
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("NotifyWhenFreeButton", () => {
  it("POSTs the window and then locks as notified", async () => {
    mockFetch();
    const window = {
      consultantProfileId: "c1",
      windowStart: "2030-01-01T10:00:00.000Z",
      windowEnd: "2030-01-01T11:00:00.000Z",
      planKind: "CONSULTATION" as const,
      planId: "p1",
    };
    wrap(<NotifyWhenFreeButton window={window} />);
    fireEvent.click(screen.getByText("Notify me if this time opens"));
    const done = await screen.findByText("You'll be notified");
    expect(calls[0]).toMatchObject({
      url: "/api/scheduling/backup-interest",
      method: "POST",
    });
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual(window);
    expect(done.closest("button")?.hasAttribute("disabled")).toBe(true);
  });
});
