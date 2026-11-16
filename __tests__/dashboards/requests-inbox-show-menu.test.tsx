/**
 * The inbox's chip set is one "Show" menu on the sort/Refresh row: a pick
 * writes `?chip=`, All clears it, and hovering an option prefetches its list.
 */

jest.mock("@/lib/payments/payouts/clawback-notifications", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .clawbackNoticesModule(),
);
jest.mock("../../lib/prisma", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").inboxPrismaModule(),
);
jest.mock("next/navigation", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .inboxNavigationModule(),
);
jest.mock("../../lib/auth-client", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").signedOutAuthModule(),
);
jest.mock("../../lib/time/use-viewer-zone", () =>
  jest
    .requireActual("../fixtures/requests-inbox-mocks")
    .kolkataViewerZoneModule(),
);
jest.mock("../../components/ui/use-toast", () =>
  jest.requireActual("../fixtures/requests-inbox-mocks").toastModule(),
);

import { act, fireEvent, screen } from "@testing-library/react";

import type { RequestsInboxPayload } from "@/lib/dashboard/requests-inbox-state";
import { NOW } from "../fixtures/requests-inbox";
import {
  mountInbox,
  readInboxPayload,
  stubDesktopMatchMedia,
} from "../fixtures/requests-inbox-render";

let payload: RequestsInboxPayload;
const fetchMock = jest.fn();

beforeAll(async () => {
  stubDesktopMatchMedia();
  payload = await readInboxPayload();
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, advanceTimers: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  globalThis.fetch = fetchMock;
  window.history.replaceState(null, "", "/?type=consultation");
});

afterEach(() => {
  jest.useRealTimers();
});

function mount() {
  mountInbox(payload, Infinity);
}

describe("Requests inbox Show menu", () => {
  it("offers the tab's chips and writes the pick to ?chip=", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Show: All" }));
    const group = screen.getByRole("group", { name: "Show" });
    expect(
      Array.from(group.querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["All", "Answer today", "Awaiting payment", "Declined"]);

    fireEvent.click(screen.getByRole("button", { name: /Awaiting payment/ }));
    expect(new URLSearchParams(window.location.search).get("chip")).toBe(
      "awaiting-payment",
    );
  });

  it("prefetches the hovered option's list", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Show: All" }));
    fireEvent.pointerEnter(screen.getByRole("button", { name: /Declined/ }));
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes("chip=declined"))).toBe(true);
  });
});
