/**
 * #1838 — the two surfaces, on the two sides of the decision.
 *
 * The pure policy is asserted in `overrun-ladder.test.ts`; this file exists for
 * the things only a screen can get wrong. A rung that fires a minute early is a
 * bug; a rung that fires correctly but tells the WRONG PERSON they can extend,
 * or quotes a price the server will not charge, is worse — because it is
 * visible, and a person acts on it.
 *
 * Rendered with `createRoot` + `act`, the pattern the room tests already use —
 * the repo has jest-dom but not @testing-library/react.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  newOverrunPurchase,
  planHardClose,
  readOverrunPurchaseView,
  reduceOverrunPurchase,
  resolveOverrunLadder,
  type OverrunPurchase,
} from "../../lib/meetings/overrun";
import ExtendModal from "../../components/meetings/ExtendModal";
import OverrunBanner from "../../components/meetings/OverrunBanner";

const START = new Date("2026-08-01T12:30:00.000Z");
const END = new Date("2026-08-01T13:30:00.000Z");
const GRACE_END = new Date("2026-08-01T13:40:00.000Z");
const NOW = new Date("2026-08-01T13:40:00.000Z");
const PAY_WINDOW = 600_000;

const ladder = (
  over: Partial<Parameters<typeof resolveOverrunLadder>[0]> = {},
) =>
  resolveOverrunLadder({
    meetingId: "meeting-1",
    startsAt: START,
    bookedEndsAt: END,
    now: NOW,
    rate: { planPricePaise: 60_000, bookedMinutes: 60 },
    ...over,
  });

function purchaseIn(
  stage: "none" | "awaiting-consultee" | "accepted" | "declined",
) {
  if (stage === "none") return null;
  const draft = {
    ...newOverrunPurchase({
      meetingId: "meeting-1",
      blockIndex: 0,
      amountPaise: 15_000,
      now: GRACE_END,
    }),
    id: "p1",
  };
  const offered = reduceOverrunPurchase(draft, { type: "offer" });
  if (stage === "awaiting-consultee") return offered;
  if (stage === "declined") {
    return reduceOverrunPurchase(offered, { type: "decline", at: NOW });
  }
  return reduceOverrunPurchase(
    reduceOverrunPurchase(offered, { type: "accept", at: NOW }),
    { type: "sendToAcquirer", paymentId: "pay_1" },
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

/**
 * `document.body`, not `host`: Radix renders `DialogContent` through a portal,
 * so a modal's DOM is a sibling of the root container rather than a child of it.
 */
const byTestId = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`);
const onScreen = () => document.body.textContent ?? "";
const click = async (id: string) => {
  const el = byTestId(id);
  if (!el) throw new Error(`no [data-testid="${id}"] rendered`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("the banner says what the ladder says", () => {
  it("renders nothing on a quiet rung", async () => {
    await render(<OverrunBanner ladder={ladder({ now: START })} />);
    expect(host.innerHTML).toBe("");
  });

  it("announces free grace in the issue's words", async () => {
    // At T+0 exactly, which is where the issue's copy lives. Halfway through
    // the grace the same banner reads "5 more min"; at 13:40 the rung has
    // already moved on to `grace-expired`.
    await render(<OverrunBanner ladder={ladder({ now: END })} />);
    const banner = byTestId("overrun-banner-grace");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(
      "You're in grace — free for 10 more min",
    );
    expect(banner?.textContent).toContain("15-minute blocks");
  });

  it("turns red only for the imminent stop", async () => {
    await render(
      <OverrunBanner
        ladder={ladder({ now: new Date("2026-08-01T13:58:00.000Z") })}
      />,
    );
    const banner = byTestId("overrun-banner-hard-close-warning");
    expect(banner?.textContent).toContain(
      "This call ends in 2 minutes. Wrap up now — it will close for everyone.",
    );
    expect(banner?.className).toContain("red");
  });

  it("renders the delivered hard-close notice rather than recomputing one", async () => {
    const steps = planHardClose({
      now: new Date("2026-08-01T13:59:00.000Z"),
      hardStopAt: new Date("2026-08-01T14:00:00.000Z"),
      participants: ["u1", "u2"],
      announcedAt: null,
    });
    expect(steps[0]?.step).toBe("announce");
    const notice = steps[0]?.step === "announce" ? steps[0].notice : null;

    await render(
      <OverrunBanner
        ladder={ladder({ now: new Date("2026-08-01T13:59:00.000Z") })}
        hardCloseNotice={notice}
      />,
    );

    const shown = byTestId("overrun-hard-close");
    expect(shown?.textContent).toContain("This call is ending");
    // The count comes from the server's notice, so the banner and the close
    // can never describe different rooms.
    expect(shown?.textContent).toContain("2 people are still connected");
  });
});

describe("the extension modal: only the host sees Extend", () => {
  it("offers the host a price from the same pro-rata the server charges", async () => {
    await render(
      <ExtendModal
        open
        ladder={ladder()}
        purchase={readOverrunPurchaseView(purchaseIn("none"), NOW, PAY_WINDOW)}
        viewer="host"
      />,
    );

    expect(byTestId("block-price")?.textContent).toBe("₹150.00");
    expect(byTestId("request-block")?.textContent).toBe(
      "Extend 15 min (₹150.00)",
    );
  });

  it("hides Extend from the consultee entirely", async () => {
    await render(
      <ExtendModal
        open
        ladder={ladder()}
        purchase={readOverrunPurchaseView(purchaseIn("none"), NOW, PAY_WINDOW)}
        viewer="consultee"
      />,
    );

    expect(byTestId("request-block")).toBeNull();
    expect(byTestId("end-now")).toBeNull();
  });

  it("warns the host about the next booking and offers nothing past it", async () => {
    const onRequestBlock = jest.fn();
    // Next booking eight minutes out — the issue's worked example.
    const capped = ladder({
      nextOccurrenceStartsAt: new Date("2026-08-01T13:38:00.000Z"),
    });

    await render(
      <ExtendModal
        open
        ladder={capped}
        purchase={readOverrunPurchaseView(purchaseIn("none"), NOW, PAY_WINDOW)}
        viewer="host"
        onRequestBlock={onRequestBlock}
      />,
    );

    expect(byTestId("back-to-back-warning")?.textContent).toContain(
      "next session starts in 8 min",
    );
    // Zero blocks of room means the button is not there at all.
    expect(capped.canRequestBlock).toBe(false);
    expect(byTestId("request-block")).toBeNull();
    expect(onRequestBlock).not.toHaveBeenCalled();
  });

  it("passes the LADDER's capped count, never a client-chosen one", async () => {
    const onRequestBlock = jest.fn();
    // A 30-minute gap to the next booking, with a stop far enough out that the
    // GAP is the binding constraint: two whole blocks, warned about.
    const capped = ladder({
      nextOccurrenceStartsAt: new Date("2026-08-01T14:00:00.000Z"),
      hardStopAt: new Date("2026-08-01T14:30:00.000Z"),
    });

    await render(
      <ExtendModal
        open
        ladder={capped}
        purchase={readOverrunPurchaseView(purchaseIn("none"), NOW, PAY_WINDOW)}
        viewer="host"
        onRequestBlock={onRequestBlock}
      />,
    );

    expect(capped.offer.limitedByNextBooking).toBe(true);
    expect(capped.offer.blocks).toBe(2);
    expect(byTestId("back-to-back-warning")?.textContent).toContain(
      "next session starts in 30 min",
    );
    await click("request-block");
    // Two, because the ladder said two. A client asking for ten is not a shape
    // this component offers.
    expect(onRequestBlock).toHaveBeenCalledWith(2);
  });
});

describe("the extension modal: the consultee's 60 seconds", () => {
  it("shows the prompt with a countdown that says silence is a no", async () => {
    const onRespond = jest.fn();
    await render(
      <ExtendModal
        open
        ladder={ladder()}
        purchase={readOverrunPurchaseView(
          purchaseIn("awaiting-consultee") as OverrunPurchase,
          NOW,
          PAY_WINDOW,
        )}
        viewer="consultee"
        onRespond={onRespond}
      />,
    );

    expect(onScreen()).toContain("Answering in 60s");
    expect(onScreen()).toContain("an unanswered prompt is a no");

    await click("accept");
    expect(onRespond).toHaveBeenCalledWith("accept");
    await click("decline");
    expect(onRespond).toHaveBeenCalledWith("decline");
  });

  it("tells the waiting host how long is left, and offers no decision", async () => {
    await render(
      <ExtendModal
        open
        ladder={ladder()}
        purchase={readOverrunPurchaseView(
          purchaseIn("awaiting-consultee") as OverrunPurchase,
          NOW,
          PAY_WINDOW,
        )}
        viewer="host"
      />,
    );

    expect(byTestId("answer-deadline")?.textContent).toContain(
      "they have 60s to answer",
    );
    expect(byTestId("request-block")).toBeNull();
  });
});

describe("the extension modal: accepted is not extended", () => {
  it("says the extra minutes have not started while payment is in flight", async () => {
    await render(
      <ExtendModal
        open
        ladder={ladder()}
        purchase={readOverrunPurchaseView(
          purchaseIn("accepted") as OverrunPurchase,
          NOW,
          PAY_WINDOW,
        )}
        viewer="host"
      />,
    );

    // The copy a consultant reads must not imply they have paid minutes.
    expect(onScreen()).toContain(
      "Agreed — taking payment now. The extra minutes start once payment completes.",
    );
    expect(byTestId("block-price")).toBeNull();
    expect(byTestId("request-block")).toBeNull();
  });

  it("still lets a declined block end the session, without charging", async () => {
    const onEndNow = jest.fn();
    await render(
      <ExtendModal
        open
        ladder={ladder()}
        purchase={readOverrunPurchaseView(
          purchaseIn("declined") as OverrunPurchase,
          NOW,
          PAY_WINDOW,
        )}
        viewer="host"
        onEndNow={onEndNow}
      />,
    );

    expect(onScreen()).toContain("Declined — no extra charge");
    await click("end-now");
    expect(onEndNow).toHaveBeenCalled();
  });
});
