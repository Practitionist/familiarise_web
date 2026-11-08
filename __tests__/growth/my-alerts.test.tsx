import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { MyAlerts } from "@/components/appointments/consultee/MyAlerts";

const zone = { zone: "Asia/Kolkata", own: true };
const future = (h: number) =>
  new Date(Date.now() + h * 3_600_000).toISOString();

const waitlistRow = (over: Record<string, unknown> = {}) => ({
  kind: "WEBINAR",
  eventId: "ev-1",
  planId: "pl-1",
  planTitle: "Intro to Rust",
  nextSessionAt: future(48),
  status: "WAITING",
  notifiedAt: null,
  checkoutHref: "/checkout/plans/webinar/pl-1",
  seatAvailable: true,
  ...over,
});
const backupRow = (over: Record<string, unknown> = {}) => ({
  id: "bi-1",
  status: "NOTIFIED",
  windowStart: future(24),
  windowEnd: future(25),
  planKind: "CONSULTATION",
  planId: "cp-1",
  consultantProfileId: "cons-1",
  consultantProfile: { user: { name: "Asha Rao" } },
  ...over,
});

function fakeResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

let calls: { url: string; method: string; body?: string }[] = [];
function mockApi(waitlist: unknown[], backup: unknown[]) {
  calls = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const data = url.startsWith("/api/scheduling/event-waitlist")
      ? waitlist
      : backup;
    return fakeResponse(200, { data: method === "GET" ? data : {} });
  }) as unknown as typeof fetch;
}

function renderAlerts() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MyAlerts viewerZone={zone} />
    </QueryClientProvider>,
  );
}

it("hides the section when both lists are empty", async () => {
  mockApi([], []);
  renderAlerts();
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
  expect(screen.queryByTestId("my-alerts")).toBeNull();
});

it("lists both kinds and shows Book now only for notified rows", async () => {
  mockApi(
    [
      waitlistRow(),
      waitlistRow({ eventId: "ev-2", planTitle: "Go", status: "NOTIFIED" }),
    ],
    [backupRow(), backupRow({ id: "bi-2", status: "WAITING" })],
  );
  renderAlerts();
  expect(await screen.findByText("Intro to Rust")).toBeTruthy();
  expect(screen.getByText(/Waiting for a seat/)).toBeTruthy();
  expect(screen.getAllByText("Asha Rao")).toHaveLength(2);
  const seat = screen.getByText("Seat open — book now").closest("a");
  expect(seat?.getAttribute("href")).toBe("/checkout/plans/webinar/pl-1");
  expect(screen.getAllByText("Book now")).toHaveLength(1);
});

it("does not offer a seat link when the event is off sale", async () => {
  mockApi([waitlistRow({ status: "NOTIFIED", seatAvailable: false })], []);
  renderAlerts();
  expect(await screen.findByText(/Waiting for a seat/)).toBeTruthy();
  expect(screen.queryByText("Seat open — book now")).toBeNull();
});

it("Leave deletes the waitlist row by kind and event", async () => {
  mockApi([waitlistRow()], []);
  renderAlerts();
  fireEvent.click(await screen.findByText("Leave"));
  await waitFor(() =>
    expect(
      calls.find(
        (c) =>
          c.method === "DELETE" && c.url === "/api/scheduling/event-waitlist",
      ),
    ).toBeTruthy(),
  );
  const del = calls.find((c) => c.method === "DELETE");
  expect(JSON.parse(del?.body ?? "{}")).toEqual({
    kind: "WEBINAR",
    eventId: "ev-1",
  });
});

it("Stop notifying me deletes the backup row by id", async () => {
  mockApi([], [backupRow()]);
  renderAlerts();
  fireEvent.click(await screen.findByText("Stop notifying me"));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
      "/api/scheduling/backup-interest?id=bi-1",
    ),
  );
});

it("keeps a window that is under way but offers no Book now", async () => {
  mockApi(
    [],
    [backupRow({ windowStart: future(-0.5), windowEnd: future(0.5) })],
  );
  renderAlerts();
  expect(await screen.findByText("Stop notifying me")).toBeTruthy();
  expect(screen.queryByText("Book now")).toBeNull();
});
