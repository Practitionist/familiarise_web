import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useAvailabilityMonth,
  useAvailabilityWindow,
} from "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow";

const dayBypass = { current: false };
const monthBypass = { current: false };
function Harness({ enabled }: { enabled: boolean }) {
  useAvailabilityWindow({
    consultantId: "expert",
    startUtc: new Date("2026-10-01T00:00:00Z"),
    endUtc: new Date("2026-10-07T23:59:59Z"),
    timezone: "UTC",
    enabled,
    bypassRef: dayBypass,
  });
  useAvailabilityMonth({
    consultantId: "expert",
    monthStart: new Date("2026-10-01T00:00:00Z"),
    timezone: "UTC",
    enabled,
    bypassRef: monthBypass,
  });
  return null;
}
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dayBypass.current = monthBypass.current = false;
  global.fetch = fetchMock
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  global.fetch = originalFetch;
});
async function render(enabled: boolean) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Harness enabled={enabled} />
      </QueryClientProvider>,
    ),
  );
}
it("does not fetch closed calendars; a conflict return bypasses fresh query and browser caches for BOTH windows", async () => {
  await render(false);
  expect(fetchMock).not.toHaveBeenCalled();
  await render(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await render(false);
  await render(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await render(false);
  dayBypass.current = monthBypass.current = true;
  await render(true);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(
    fetchMock.mock.calls
      .slice(2)
      .every(([, options]) => options?.cache === "no-store"),
  ).toBe(true);
  expect(dayBypass.current).toBe(false);
  expect(monthBypass.current).toBe(false);
});
