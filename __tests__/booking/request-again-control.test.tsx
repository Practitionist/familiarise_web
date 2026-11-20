/**
 * "Request again" on a booking whose order is still PENDING past its window
 * warns, closes the old order through the route, and only then navigates.
 * Pins the control, what it sends against the route's schema, and the Home
 * widget skipping an edge the click itself wrote; the route's answers are
 * pinned in request-again-route.test.ts.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockRouter = { push: jest.fn(), refresh: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter }));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { RequestAgainButton } from "../../components/booking/RequestAgainButton";
import {
  openOrderPastWindow,
  REQUEST_AGAIN_ALREADY_PAID,
  REQUEST_AGAIN_WARNING,
  RequestAgainParamsSchema,
  requestAgainPath,
} from "../../lib/booking/request-again-rules";
import { toLapsedPayLinks } from "../../lib/dashboard/lapsed-pay-links";

const BOOKING = "7f1c2a9e-4b6d-4c1a-9e2f-0a1b2c3d4e5f";
const HREF = "/explore/experts/profile-1";
const NOW = new Date("2026-11-20T12:00:00Z");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.refresh.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

type Row = { paymentStatus: string; expiresAt: Date | string | null };
const lapsed: Row[] = [
  { paymentStatus: "PENDING", expiresAt: new Date(Date.now() - 60_000) },
];

function render(payments: Row[]) {
  act(() =>
    root.render(
      <RequestAgainButton
        appointmentId={BOOKING}
        href={HREF}
        payments={payments}
      >
        Book again
      </RequestAgainButton>,
    ),
  );
}

const buttonNamed = (name: string) => {
  const match = [...document.querySelectorAll("button, a")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLElement)) throw new Error(`no "${name}"`);
  return match;
};

function answering(status: number, body: unknown) {
  const fetchSpy = jest.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }));
  Object.assign(globalThis, { fetch: fetchSpy });
  return fetchSpy;
}

describe("openOrderPastWindow", () => {
  it("is true only for a PENDING order whose window has closed", () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      openOrderPastWindow([{ paymentStatus: "PENDING", expiresAt: past }], NOW),
    ).toBe(true);
    expect(
      openOrderPastWindow(
        [
          { paymentStatus: "PENDING", expiresAt: future },
          { paymentStatus: "PENDING", expiresAt: null },
          { paymentStatus: "EXPIRED", expiresAt: past },
        ],
        NOW,
      ),
    ).toBe(false);
  });
});

describe("RequestAgainButton", () => {
  it("with no open order, navigates without asking or calling the route", () => {
    const fetchSpy = answering(200, { closed: 0 });
    render([]);
    expect(buttonNamed("Book again").getAttribute("href")).toBe(HREF);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(REQUEST_AGAIN_WARNING);
  });

  it("warns first, closes the old order through the route, then navigates", async () => {
    const fetchSpy = answering(200, { closed: 1 });
    render(lapsed);

    act(() => buttonNamed("Book again").click());
    expect(document.body.textContent).toContain(REQUEST_AGAIN_WARNING);
    expect(fetchSpy).not.toHaveBeenCalled();

    await act(async () => buttonNamed("Close it and continue").click());

    expect(fetchSpy).toHaveBeenCalledWith(requestAgainPath(BOOKING), {
      method: "POST",
    });
    // What the control sends is what the route's schema accepts.
    const url = String((fetchSpy.mock.calls[0] as unknown as [string])[0]);
    const bookingId = decodeURIComponent(url.split("/")[3]);
    expect(RequestAgainParamsSchema.safeParse({ bookingId }).success).toBe(
      true,
    );
    expect(mockRouter.push).toHaveBeenCalledWith(HREF);
  });

  it("a capture that won first: says so and never starts the new request", async () => {
    answering(409, { code: "ALREADY_PAID", error: REQUEST_AGAIN_ALREADY_PAID });
    render(lapsed);

    act(() => buttonNamed("Book again").click());
    await act(async () => buttonNamed("Close it and continue").click());

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.refresh).toHaveBeenCalled();
    // The refresh brings the captured row, and the notice stays.
    render([{ paymentStatus: "SUCCEEDED", expiresAt: null }]);
    expect(document.body.textContent).toContain(REQUEST_AGAIN_ALREADY_PAID);
  });

  it("decides at the click: a window that closed after the render still closes first", async () => {
    const fetchSpy = answering(200, { closed: 1 });
    render([
      { paymentStatus: "PENDING", expiresAt: new Date(Date.now() + 20) },
    ]);
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));

    act(() => buttonNamed("Book again").click());

    expect(document.body.textContent).toContain(REQUEST_AGAIN_WARNING);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the Home lapsed-link list", () => {
  it("skips a request the learner closed by requesting again", () => {
    const edge = (reason: string | null) => ({
      fromStatus: "APPROVED_PENDING_PAYMENT",
      toStatus: "EXPIRED",
      reason,
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    const row = (id: string, reason: string | null) => ({
      id,
      type: "consultation" as const,
      title: "Plan",
      consultantName: "Asha",
      consultantProfileId: "profile-1",
      expertPublic: true,
      history: [edge(reason)],
    });
    const links = toLapsedPayLinks(
      [row("lapsed", null), row("requested-again", "REQUESTED_AGAIN")],
      NOW,
    );
    expect(links.map((l) => l.id)).toEqual(["lapsed"]);
  });
});
