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
  const window = {
    consultantProfileId: "c1",
    windowStart: "2030-01-01T10:00:00.000Z",
    windowEnd: "2030-01-01T11:00:00.000Z",
    planKind: "CONSULTATION" as const,
    planId: "p1",
  };
  const waiting = {
    data: [{ id: "w1", status: "WAITING", ...window }],
  };

  it("POSTs the window, then reads Waiting with a withdraw; shows a refusal inline", async () => {
    let listed = false;
    calls = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string });
      if (method === "POST") listed = true;
      if (method === "DELETE") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Could not withdraw" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => (listed ? waiting : { data: [] }),
      };
    }) as unknown as typeof fetch;
    wrap(<NotifyWhenFreeButton window={window} timeLabel="10:00 am" />);
    const notify = await screen.findByRole("button", {
      name: "Notify me if 10:00 am opens",
    });
    await waitFor(() => expect(notify).toBeEnabled());
    fireEvent.click(notify);
    await screen.findByText("Waiting");
    const post = calls.find((call) => call.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual(window);
    fireEvent.click(
      screen.getByRole("button", { name: /stop waiting on 10:00 am/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not withdraw",
    );
  });

  it("sends a signed-out visitor to sign in instead of posting", () => {
    mockFetch();
    const onSignIn = jest.fn();
    wrap(
      <NotifyWhenFreeButton
        window={window}
        timeLabel="10:00 am"
        onSignIn={onSignIn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Notify me/ }));
    expect(onSignIn).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
