/**
 * @jest-environment node
 */

/**
 * #1838 — the ladder's boundaries, the derived grace state, and the pro-rata.
 *
 * Every assertion here is a boundary or a refusal, because those are the two
 * ways this feature fails without anyone noticing: a rung that flips one minute
 * early charges a person for a minute they had free, and a grace window that is
 * not durable either bills forever or cuts a paid session short.
 *
 * The reported session throughout is a ONE-HOUR consultation starting at
 * 12:30Z, so: T+0 at 13:30Z, grace end at 13:40Z, and — with no cap supplied —
 * the ladder's own join backstop at 14:00Z.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  EXTEND_BLOCK_MIN,
  HARD_CLOSE_ESCALATION_MS,
  HARD_CLOSE_WARN_MS,
  OVERRUN_GRACE_MS,
  OVERRUN_WARN_MS,
  OVERRUN_JOIN_BACKSTOP_MS,
  extensionCapFor,
  newOverrunPurchase,
  planHardClose,
  proRataBasePaiseForBlock,
  readOverrunPurchaseView,
  reduceOverrunPurchase,
  resolveOverrunGrace,
  resolveOverrunLadder,
  settleOverrunPurchase,
  OverrunTransitionError,
  type OverrunPurchase,
  type OverrunPurchaseEvent,
  type OverrunPurchaseState,
} from "../../lib/meetings/overrun";

/**
 * The allowed-from map, transcribed. Deliberately a SEPARATE copy: if the test
 * read the map out of the module it would agree with any edit to it, which is
 * the opposite of what a boundary test is for.
 */
const LEGAL: Record<OverrunPurchaseState, readonly OverrunPurchaseState[]> = {
  REQUESTED: [],
  AWAITING_CONSULTEE: ["REQUESTED"],
  ACCEPTED: ["AWAITING_CONSULTEE"],
  DECLINED: ["AWAITING_CONSULTEE", "AWAITING_PAYMENT"],
  AWAITING_PAYMENT: ["ACCEPTED"],
  GRANTED: ["AWAITING_PAYMENT"],
  EXPIRED: ["AWAITING_CONSULTEE", "AWAITING_PAYMENT"],
  PAYMENT_FAILED: ["AWAITING_PAYMENT"],
};

/**
 * "did the reducer move it, or refuse it" — as a value, so the assertion that
 * follows can be unconditional.
 */
function attemptTransition(
  purchase: OverrunPurchase,
  event: OverrunPurchaseEvent,
): "moved" | "refused" | "threw-something-else" {
  try {
    reduceOverrunPurchase(purchase, event);
    return "moved";
  } catch (error) {
    return error instanceof OverrunTransitionError
      ? "refused"
      : "threw-something-else";
  }
}

const START = new Date("2026-08-01T12:30:00.000Z");
const END = new Date("2026-08-01T13:30:00.000Z");
const GRACE_END = new Date("2026-08-01T13:40:00.000Z");
const BACKSTOP = new Date("2026-08-01T14:00:00.000Z");

const at = (iso: string) => new Date(iso);

const ladder = (
  now: Date,
  over: Partial<Parameters<typeof resolveOverrunLadder>[0]> = {},
) =>
  resolveOverrunLadder({
    meetingId: "meeting-1",
    startsAt: START,
    bookedEndsAt: END,
    now,
    rate: { planPricePaise: 60_000, bookedMinutes: 60 },
    ...over,
  });

/** Take a fresh block all the way to GRANTED. */
function grant(args: {
  blockIndex: number;
  minutes?: number;
  at: Date;
}): OverrunPurchase {
  const offered = reduceOverrunPurchase(
    {
      ...newOverrunPurchase({
        meetingId: "meeting-1",
        blockIndex: args.blockIndex,
        minutes: args.minutes ?? EXTEND_BLOCK_MIN,
        amountPaise: 15_000,
        now: args.at,
      }),
      id: `p${args.blockIndex}`,
    },
    { type: "offer" },
  );
  return reduceOverrunPurchase(
    reduceOverrunPurchase(
      reduceOverrunPurchase(offered, { type: "accept", at: args.at }),
      { type: "sendToAcquirer", paymentId: `pay${args.blockIndex}` },
    ),
    { type: "capture", at: args.at, paymentId: `pay${args.blockIndex}` },
  );
}

describe("the free grace window is derived, never stored", () => {
  it("is the slot's own end plus the grace, not a wall clock read", () => {
    const grace = resolveOverrunGrace({ meetingId: "m1", bookedEndsAt: END });

    expect(grace).toEqual({
      meetingId: "m1",
      endsAt: GRACE_END,
      source: "derived",
    });
    // Same answer whether the caller's clock says 12:00 or 23:00: the anchor
    // is the slot, so the window cannot drift with a slow instance.
    expect(
      resolveOverrunGrace({ meetingId: "m1", bookedEndsAt: END })?.endsAt,
    ).toEqual(GRACE_END);
  });

  it("is null when the slot carries no end, rather than guessing one", () => {
    expect(
      resolveOverrunGrace({ meetingId: "m1", bookedEndsAt: null }),
    ).toBeNull();
  });

  /**
   * The teeth. A module-scope `Map` would answer the first call and answer
   * `null` to the second, which is precisely what a second Lambda instance sees
   * on a Netlify function. `jest.isolateModules` gives a genuinely fresh module
   * registry — the closest a unit test gets to a cold instance.
   */
  it("survives a fresh module registry, which is what a second Lambda sees", () => {
    const source = readFileSync(
      join(__dirname, "../../lib/meetings/overrun.ts"),
      "utf8",
    );

    const first = resolveOverrunGrace({ meetingId: "m1", bookedEndsAt: END });

    const seen = new Map<string, Date | undefined>();
    jest.isolateModules(() => {
      // `require` is the point: `jest.isolateModules` hands the callback a
      // FRESH module registry, and only a CommonJS require inside it loads the
      // module a second time. That second load is the unit-test stand-in for a
      // cold Lambda instance.
      const mod =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../lib/meetings/overrun") as typeof import("../../lib/meetings/overrun");
      seen.set(
        "coldFirst",
        mod.resolveOverrunGrace({ meetingId: "m1", bookedEndsAt: END })?.endsAt,
      );
      // A DIFFERENT meeting in the same registry, so a shared cache would
      // surface here too.
      seen.set(
        "coldOther",
        mod.resolveOverrunGrace({ meetingId: "m2", bookedEndsAt: END })?.endsAt,
      );
    });

    expect(seen.get("coldFirst")).toEqual(first?.endsAt);
    expect(seen.get("coldOther")).toEqual(first?.endsAt);

    // And structurally: no module-level mutable container exists to drift.
    const mutableAtModuleScope =
      /^(?!.*\bfunction\b)(?:const|let|var)\s+\w+\s*=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/m;
    expect(mutableAtModuleScope.test(source)).toBe(false);
  });
});

describe("the ladder's rungs and their exact boundaries", () => {
  it("is quiet before T-5 and warns at exactly T-5", () => {
    // One millisecond before the threshold: still an ordinary session.
    expect(ladder(at("2026-08-01T13:24:59.999Z")).rung).toBe("in-progress");
    expect(ladder(at("2026-08-01T13:24:59.999Z")).status).toBe("");

    // The threshold itself belongs to the warning, not to "fine for now".
    const warn = ladder(at("2026-08-01T13:25:00.000Z"));
    expect(warn.rung).toBe("wrapping-up");
    expect(warn.status).toBe("5 min left — start wrapping up");
    // T-5 is a PILL change in the issue's table, not a banner.
    expect(warn.banner).toBeNull();
  });

  it("opens free grace at exactly T+0 and closes it at exactly +10", () => {
    const oneMsEarly = ladder(at("2026-08-01T13:29:59.999Z"));
    expect(oneMsEarly.rung).toBe("wrapping-up");

    const t0 = ladder(at("2026-08-01T13:30:00.000Z"));
    expect(t0.rung).toBe("grace");
    expect(t0.status).toBe("10 min of free grace");
    // The issue's T+0 copy, including the billing rule.
    expect(t0.banner).toContain("free for 10 more min");
    expect(t0.banner).toContain(`${EXTEND_BLOCK_MIN}-minute blocks`);
    expect(t0.canRequestBlock).toBe(false);

    const lastFreeMs = ladder(at("2026-08-01T13:39:59.999Z"));
    expect(lastFreeMs.rung).toBe("grace");

    // The millisecond the free time is gone. Past this a minute is billable,
    // and only with consent.
    const billable = ladder(at("2026-08-01T13:40:00.000Z"));
    expect(billable.rung).toBe("grace-expired");
    expect(billable.canRequestBlock).toBe(true);
  });

  it("announces the stop at exactly cap-2 and closes at exactly the cap", () => {
    // One millisecond outside the announcement window: nothing said yet.
    expect(ladder(at("2026-08-01T13:57:59.999Z")).rung).toBe("grace-expired");

    const announced = ladder(at("2026-08-01T13:58:00.000Z"));
    expect(announced.rung).toBe("hard-close-warning");
    expect(announced.status).toBe("Call ends in 2 min");
    expect(announced.banner).toContain("ends in 2 minutes");
    // Selling minutes the SFU is about to cut is selling dead air.
    expect(announced.canRequestBlock).toBe(false);

    const lastWarnedMs = ladder(at("2026-08-01T13:59:59.999Z"));
    expect(lastWarnedMs.rung).toBe("hard-close-warning");

    const closed = ladder(at("2026-08-01T14:00:00.000Z"));
    expect(closed.rung).toBe("closed");
    expect(closed.status).toBe("Call ended");
    // Past the stop there is no banner — the call is over, not warning.
    expect(closed.banner).toBeNull();
  });

  it("never lets grace outlive the stop", () => {
    // A caller supplying a stop tighter than the nominal grace gets the
    // tighter of the two: the stop is 13:37, so free time ends there even
    // though `OVERRUN_GRACE_MS` would have run to 13:40.
    const tight = resolveOverrunLadder({
      meetingId: "m1",
      startsAt: START,
      bookedEndsAt: END,
      now: at("2026-08-01T13:34:00.000Z"),
      hardStopAt: at("2026-08-01T13:37:00.000Z"),
      rate: { planPricePaise: 60_000, bookedMinutes: 60 },
    });
    expect(tight.rung).toBe("grace");
    expect(tight.status).toBe("3 min of free grace");
    expect(tight.grace?.endsAt).toEqual(GRACE_END);
    // And the moment the stop is inside two minutes, the announcement wins
    // over any notion of grace still running.
    const imminent = resolveOverrunLadder({
      meetingId: "m1",
      startsAt: START,
      bookedEndsAt: END,
      now: at("2026-08-01T13:35:00.000Z"),
      hardStopAt: at("2026-08-01T13:37:00.000Z"),
      rate: { planPricePaise: 60_000, bookedMinutes: 60 },
    });
    expect(imminent.rung).toBe("hard-close-warning");
  });

  it("is unknown — not optimistic — when the slot has no end", () => {
    const blind = ladder(at("2026-08-01T14:00:00.000Z"), {
      bookedEndsAt: null,
    });
    expect(blind.rung).toBe("unknown");
    expect(blind.canRequestBlock).toBe(false);
    expect(blind.status).toBe("");
  });
});

describe("each billing block is a separate purchase with its own consent", () => {
  it("prices a block as the plan's own per-minute rate", () => {
    // ₹600 for 60 minutes is ₹10/min, so a 15-minute block is ₹150.
    expect(
      proRataBasePaiseForBlock(
        { planPricePaise: 60_000, bookedMinutes: 60 },
        1,
      ),
    ).toBe(15_000);
    // Four blocks buy the whole session again — no more, no less.
    expect(
      proRataBasePaiseForBlock(
        { planPricePaise: 60_000, bookedMinutes: 60 },
        4,
      ),
    ).toBe(60_000);
  });

  it("floors rather than rounding up, so no repeat can over-bill", () => {
    // ₹10.00 over 7 minutes → 10,000/7 × 15 = 21,428.57 paise.
    const one = proRataBasePaiseForBlock(
      { planPricePaise: 10_000, bookedMinutes: 7 },
      1,
    );
    expect(one).toBe(21_428);
    // Three separate one-block purchases still never exceed the exact sum.
    expect(one * 3).toBeLessThanOrEqual(64_285);
  });

  it("refuses to invent a rate, rather than guessing a denominator", () => {
    expect(
      proRataBasePaiseForBlock({ planPricePaise: 60_000, bookedMinutes: 0 }, 1),
    ).toBe(0);
    expect(
      proRataBasePaiseForBlock({ planPricePaise: 0, bookedMinutes: 60 }, 1),
    ).toBe(0);
    expect(() =>
      proRataBasePaiseForBlock(
        { planPricePaise: 60_000, bookedMinutes: 60 },
        0,
      ),
    ).toThrow(RangeError);
  });

  it("prices the ladder's block from the rate it was given", () => {
    const l = ladder(at("2026-08-01T13:40:00.000Z"));
    expect(l.blockPricePaise).toBe(15_000);
    expect(l.grantedMinutes).toBe(0);
  });

  it("only GRANTED blocks extend the window, and each one adds its own minutes", () => {
    const none = ladder(at("2026-08-01T13:50:00.000Z"));
    expect(none.rung).toBe("grace-expired");
    expect(none.grantedMinutes).toBe(0);

    const one = ladder(at("2026-08-01T13:50:00.000Z"), {
      purchases: [grant({ blockIndex: 0, at: GRACE_END })],
    });
    expect(one.grantedMinutes).toBe(EXTEND_BLOCK_MIN);
    expect(one.rung).toBe("extended");

    // Two blocks, against a stop that is far enough out to hold them. Without
    // an explicit cap the ladder's own 30-minute backstop ends at 14:00, which
    // is exactly one block — see the next test.
    const stop = at("2026-08-01T14:30:00.000Z");
    const twoBlocks = [
      grant({ blockIndex: 0, at: GRACE_END }),
      grant({ blockIndex: 1, at: at("2026-08-01T13:55:00.000Z") }),
    ];
    const two = ladder(at("2026-08-01T13:55:00.000Z"), {
      hardStopAt: stop,
      purchases: twoBlocks,
    });
    expect(two.grantedMinutes).toBe(EXTEND_BLOCK_MIN * 2);
    expect(two.rung).toBe("extended");

    // The last millisecond of the second block, and the one after it.
    const lastMs = ladder(at("2026-08-01T14:09:59.999Z"), {
      hardStopAt: stop,
      purchases: twoBlocks,
    });
    expect(lastMs.rung).toBe("extended");
    expect(lastMs.status).toBe("1 min of paid extension left");
    const expired = ladder(at("2026-08-01T14:10:00.000Z"), {
      hardStopAt: stop,
      purchases: twoBlocks,
    });
    expect(expired.rung).toBe("grace-expired");
  });

  /**
   * A real consequence of not consuming the Stream cap, pinned so it cannot
   * change silently: with only the join backstop known, free grace ends at
   * 13:40 and the stop is 14:00, which is exactly one 15-minute block. A
   * second block is therefore never OFFERED. The day the duration cap is
   * trustworthy and a 60-minute booking legitimately runs to 14:15, this
   * ceiling moves on its own — nothing here changes but the input.
   */
  it("offers exactly one block when the stop is only the join backstop", () => {
    const first = ladder(at("2026-08-01T13:40:00.000Z"));
    expect(first.offer.blocks).toBe(1);
    expect(first.canRequestBlock).toBe(true);

    // At 13:55, inside the first block, only four minutes of room remain —
    // less than a block, so a second is not sold.
    const second = ladder(at("2026-08-01T13:55:00.000Z"));
    expect(second.offer.blocks).toBe(0);
    expect(second.canRequestBlock).toBe(false);
  });
});

describe("the purchase state machine", () => {
  const draft = () =>
    newOverrunPurchase({
      meetingId: "m1",
      blockIndex: 0,
      amountPaise: 15_000,
      now: GRACE_END,
    });

  it("reaches GRANTED only through a capture", () => {
    const offered = reduceOverrunPurchase(draft(), { type: "offer" });
    expect(offered.state).toBe("AWAITING_CONSULTEE");

    const accepted = reduceOverrunPurchase(offered, {
      type: "accept",
      at: at("2026-08-01T13:40:10.000Z"),
    });
    expect(accepted.state).toBe("ACCEPTED");

    const paying = reduceOverrunPurchase(accepted, {
      type: "sendToAcquirer",
      paymentId: "pay_1",
    });
    expect(paying.state).toBe("AWAITING_PAYMENT");

    const captured = reduceOverrunPurchase(paying, {
      type: "capture",
      at: at("2026-08-01T13:40:25.000Z"),
      paymentId: "pay_1",
    });
    expect(captured.state).toBe("GRANTED");
    expect(captured.capturedAt).toEqual(at("2026-08-01T13:40:25.000Z"));
  });

  /**
   * The whole allowed-from map, as one assertion.
   *
   * The map is keyed by TARGET and is meant to be the same set the durable
   * CAS puts in its WHERE clause. A transition nobody expected to be illegal
   * — most dangerously one OUT of `GRANTED`, which would silently retract paid
   * minutes — has to fail here as loudly as the obvious ones, so every state is
   * enumerated rather than spot-checked.
   */
  it("refuses every move the map does not name", () => {
    const states: OverrunPurchaseState[] = [
      "REQUESTED",
      "AWAITING_CONSULTEE",
      "ACCEPTED",
      "AWAITING_PAYMENT",
      "GRANTED",
      "DECLINED",
      "EXPIRED",
      "PAYMENT_FAILED",
    ];
    const events: Array<{
      event: OverrunPurchaseEvent;
      target: OverrunPurchaseState;
    }> = [
      { event: { type: "offer" }, target: "AWAITING_CONSULTEE" },
      { event: { type: "accept", at: GRACE_END }, target: "ACCEPTED" },
      {
        event: { type: "decline", at: GRACE_END },
        target: "DECLINED",
      },
      {
        event: { type: "expire", at: GRACE_END, reason: "X" },
        target: "EXPIRED",
      },
      {
        event: { type: "sendToAcquirer", paymentId: "pay_1" },
        target: "AWAITING_PAYMENT",
      },
      { event: { type: "capture", at: GRACE_END }, target: "GRANTED" },
      {
        event: { type: "failPayment", at: GRACE_END, reason: "X" },
        target: "PAYMENT_FAILED",
      },
    ];

    // One unconditional assertion: the outcome is computed, then compared. A
    // bare `if` around an `expect` is an assertion that stops running when the
    // branch flips, which is how a state-machine test goes green while
    // checking nothing.
    for (const from of states) {
      for (const { event, target } of events) {
        const legal = LEGAL[target].includes(from);
        const outcome = attemptTransition(
          { ...draft(), id: "p", state: from },
          event,
        );
        expect({
          from,
          to: target,
          outcome,
          expected: legal ? "moved" : "refused",
        }).toEqual({
          from,
          to: target,
          outcome,
          expected: legal ? "moved" : "refused",
        });
      }
    }
  });

  it("will not walk a granted block backwards to a decline", () => {
    const paid = grant({ blockIndex: 0, at: GRACE_END });
    expect(paid.state).toBe("GRANTED");

    // Retracting paid minutes is the one move that must never be expressible:
    // the money is captured and the minutes were consumed.
    expect(() =>
      reduceOverrunPurchase(paid, { type: "decline", at: GRACE_END }),
    ).toThrow(/cannot move GRANTED → DECLINED/);
    expect(() =>
      reduceOverrunPurchase(paid, {
        type: "expire",
        at: GRACE_END,
        reason: "LAPSED",
      }),
    ).toThrow(/cannot move GRANTED → EXPIRED/);
    expect(() =>
      reduceOverrunPurchase(paid, { type: "capture", at: GRACE_END }),
    ).toThrow(/cannot move GRANTED → GRANTED/);
  });

  it("refuses a capture that never went to an acquirer", () => {
    const offered = reduceOverrunPurchase(draft(), { type: "offer" });
    // GRANTED is unreachable without a capture, and the refusal is typed so a
    // caller can tell "the state machine said no" from "something broke".
    expect(attemptTransition(offered, { type: "capture", at: GRACE_END })).toBe(
      "refused",
    );
    expect(() =>
      reduceOverrunPurchase(offered, { type: "capture", at: GRACE_END }),
    ).toThrow(/cannot move AWAITING_CONSULTEE → GRANTED/);
  });

  it("treats an unanswered prompt as a decline at exactly 60 seconds", () => {
    const offered = {
      ...reduceOverrunPurchase(draft(), { type: "offer" }),
      id: "p1",
    };

    const oneMsShort = settleOverrunPurchase(
      offered,
      at("2026-08-01T13:40:59.999Z"),
      600_000,
    );
    expect(oneMsShort.state).toBe("AWAITING_CONSULTEE");

    const atDeadline = settleOverrunPurchase(
      offered,
      at("2026-08-01T13:41:00.000Z"),
      600_000,
    );
    expect(atDeadline.state).toBe("EXPIRED");
    expect(atDeadline.reason).toBe("CONSULTEE_TIMEOUT");
    // And the reason the issue insists on: no charge.
    expect(
      readOverrunPurchaseView(
        atDeadline,
        at("2026-08-01T13:41:00.000Z"),
        600_000,
      ),
    ).toMatchObject({
      stage: "expired",
      extendsWindow: false,
    });
  });

  it("lapses a payment window that never completed", () => {
    const paying = {
      ...reduceOverrunPurchase(
        reduceOverrunPurchase(
          { ...reduceOverrunPurchase(draft(), { type: "offer" }), id: "p1" },
          { type: "accept", at: at("2026-08-01T13:40:10.000Z") },
        ),
        { type: "sendToAcquirer", paymentId: "pay_1" },
      ),
    };

    const lapsed = settleOverrunPurchase(
      paying,
      at("2026-08-01T13:50:10.000Z"),
      600_000,
    );
    expect(lapsed.state).toBe("EXPIRED");
    expect(lapsed.reason).toBe("PAYMENT_WINDOW_LAPSED");
  });

  /**
   * The teeth for the issue's "payment fails mid-call" edge case: a consultee
   * who agreed and money that never landed buys nothing.
   */
  it("does not extend the window for an agreed-but-uncaptured block", () => {
    const paying = reduceOverrunPurchase(
      reduceOverrunPurchase(
        reduceOverrunPurchase(
          {
            ...newOverrunPurchase({
              meetingId: "m1",
              blockIndex: 0,
              amountPaise: 15_000,
              now: GRACE_END,
            }),
            id: "p1",
          },
          { type: "offer" },
        ),
        { type: "accept", at: at("2026-08-01T13:40:10.000Z") },
      ),
      { type: "sendToAcquirer", paymentId: "pay_1" },
    );

    const view = readOverrunPurchaseView(
      paying,
      at("2026-08-01T13:40:30.000Z"),
      600_000,
    );
    expect(view.stage).toBe("accepted-awaiting-payment");
    expect(view.extendsWindow).toBe(false);
    // And the ladder, fed the same unpaid row, grants nothing.
    expect(
      ladder(at("2026-08-01T13:50:00.000Z"), { purchases: [paying] })
        .grantedMinutes,
    ).toBe(0);

    const failed = reduceOverrunPurchase(paying, {
      type: "failPayment",
      at: at("2026-08-01T13:41:00.000Z"),
      reason: "GATEWAY_DECLINED",
    });
    expect(
      readOverrunPurchaseView(failed, at("2026-08-01T13:41:00.000Z"), 600_000),
    ).toMatchObject({ stage: "payment-failed", extendsWindow: false });
    expect(
      ladder(at("2026-08-01T13:50:00.000Z"), { purchases: [failed] })
        .grantedMinutes,
    ).toBe(0);
  });

  /**
   * `GRANTED` is only reachable through a capture, so a row claiming `GRANTED`
   * with no `capturedAt` cannot be built by this module. It can exist in the
   * DATABASE — a hand-written row, a backfill, a partially-applied migration —
   * and the ladder is what reads it. The minutes stay locked.
   */
  it("does not extend the window for a GRANTED row with no capture on it", () => {
    const corrupt: OverrunPurchase = {
      ...grant({ blockIndex: 0, at: GRACE_END }),
      capturedAt: null,
    };
    expect(corrupt.state).toBe("GRANTED");
    expect(
      ladder(at("2026-08-01T13:50:00.000Z"), {
        hardStopAt: at("2026-08-01T14:30:00.000Z"),
        purchases: [corrupt],
      }).grantedMinutes,
    ).toBe(0);
    // And the view agrees, so the room is not told it has paid minutes.
    expect(
      readOverrunPurchaseView(corrupt, at("2026-08-01T13:50:00.000Z"), 600_000)
        .extendsWindow,
    ).toBe(false);
  });

  it("does not extend the window for a refusal", () => {
    const declined = reduceOverrunPurchase(
      reduceOverrunPurchase({ ...draft(), id: "p1" }, { type: "offer" }),
      { type: "decline", at: at("2026-08-01T13:40:20.000Z") },
    );
    expect(
      ladder(at("2026-08-01T13:50:00.000Z"), { purchases: [declined] })
        .grantedMinutes,
    ).toBe(0);
    expect(
      readOverrunPurchaseView(
        declined,
        at("2026-08-01T13:50:00.000Z"),
        600_000,
      ),
    ).toMatchObject({ stage: "declined", extendsWindow: false });
  });
});

describe("the back-to-back guard", () => {
  it("caps the extension to the gap before the next booking", () => {
    // Next session starts 8 minutes after this one ends — the issue's example.
    const cap = extensionCapFor({
      bookedEndsAt: END,
      now: at("2026-08-01T13:40:00.000Z"),
      nextOccurrenceStartsAt: at("2026-08-01T13:38:00.000Z"),
      hardStopAt: null,
    });
    expect(cap.blocks).toBe(0);
    expect(cap.limitedByNextBooking).toBe(true);
    expect(cap.minutesBeforeNext).toBe(8);
    // Warned BEFORE accepting, with the actual gap in the words.
    expect(cap.warning).toContain("next session starts in 8 min");
  });

  it("allows exactly one block when the gap is a full block wide", () => {
    const cap = extensionCapFor({
      bookedEndsAt: END,
      now: at("2026-08-01T13:40:00.000Z"),
      nextOccurrenceStartsAt: at("2026-08-01T13:45:00.000Z"),
      hardStopAt: null,
    });
    expect(cap.blocks).toBe(1);
    expect(cap.limitedByNextBooking).toBe(true);
  });

  it("refuses to sell past a hard stop, because those minutes are dead air", () => {
    const cap = extensionCapFor({
      bookedEndsAt: END,
      now: at("2026-08-01T13:41:00.000Z"),
      nextOccurrenceStartsAt: null,
      hardStopAt: at("2026-08-01T13:50:00.000Z"),
    });
    expect(cap.blocks).toBe(0);
    expect(cap.limitedByNextBooking).toBe(false);

    const ladderAtStop = ladder(at("2026-08-01T13:41:00.000Z"), {
      hardStopAt: at("2026-08-01T13:50:00.000Z"),
    });
    expect(ladderAtStop.canRequestBlock).toBe(false);
  });

  it("falls back to its own backstop when no cap is supplied", () => {
    const fallback = ladder(at("2026-08-01T13:58:00.000Z"));
    expect(fallback.hardStopAt).toEqual(BACKSTOP);
    expect(BACKSTOP.getTime() - END.getTime()).toBe(OVERRUN_JOIN_BACKSTOP_MS);
  });
});

describe("the hard close announces before it acts", () => {
  const stop = BACKSTOP;

  it("says nothing until two minutes out", () => {
    expect(
      planHardClose({
        now: at("2026-08-01T13:57:59.999Z"),
        hardStopAt: stop,
        participants: ["u1", "u2"],
        announcedAt: null,
      }),
    ).toEqual([]);
  });

  it("announces at the boundary, and counts who is still connected", () => {
    const steps = planHardClose({
      now: at("2026-08-01T13:58:00.000Z"),
      hardStopAt: stop,
      participants: ["u1", "u2"],
      announcedAt: null,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("announce");
    const notice = (
      steps[0] as {
        notice: {
          body: string;
          participantCount: number;
          secondsRemaining: number;
        };
      }
    ).notice;
    expect(notice.participantCount).toBe(2);
    expect(notice.secondsRemaining).toBe(120);
    expect(notice.body).toContain("2 people are still connected");
    // The whole point: announcing is not ending.
    expect(steps.some((s) => s.step === "end-call")).toBe(false);
  });

  /**
   * The teeth. Even PAST the stop, an unannounced call is not ended — it is
   * announced. Revert the `announcedAt === null` early return and this fails.
   */
  it("still only announces when it is already past the stop", () => {
    const steps = planHardClose({
      now: at("2026-08-01T14:00:00.000Z"),
      hardStopAt: stop,
      participants: ["u1"],
      announcedAt: null,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe("announce");
    expect(steps[0].step === "end-call").toBe(false);
  });

  it("ends only after the announcement is out and its grace has elapsed", () => {
    // Announced at 13:58 but the stop has not arrived: nothing to do.
    expect(
      planHardClose({
        now: at("2026-08-01T13:59:00.000Z"),
        hardStopAt: stop,
        participants: ["u1"],
        announcedAt: at("2026-08-01T13:58:00.000Z"),
      }),
    ).toEqual([]);

    // Stop reached, announcement 10 seconds old: still not enough.
    const tooSoon = planHardClose({
      now: at("2026-08-01T14:00:10.000Z"),
      hardStopAt: stop,
      participants: ["u1"],
      announcedAt: at("2026-08-01T14:00:00.000Z"),
    });
    expect(tooSoon).toEqual([]);

    // Announcement aged past the escalation window: close it.
    const close = planHardClose({
      now: new Date(
        at("2026-08-01T14:00:00.000Z").getTime() + HARD_CLOSE_ESCALATION_MS,
      ),
      hardStopAt: stop,
      participants: ["u1", "u2"],
      announcedAt: at("2026-08-01T14:00:00.000Z"),
    });
    expect(close).toHaveLength(1);
    expect(close[0].step).toBe("end-call");
    expect(close[0]).toMatchObject({
      reason: "duration_cap_reached",
      // The participant list rides out so attendance can be recorded.
      participants: ["u1", "u2"],
    });
  });

  it("ends an announced call at exactly the escalation boundary", () => {
    const announcedAt = at("2026-08-01T13:59:50.000Z");
    const justUnder = planHardClose({
      now: new Date(announcedAt.getTime() + HARD_CLOSE_ESCALATION_MS - 1),
      hardStopAt: stop,
      participants: [],
      announcedAt,
    });
    expect(justUnder).toEqual([]);

    const exactly = planHardClose({
      now: new Date(announcedAt.getTime() + HARD_CLOSE_ESCALATION_MS),
      hardStopAt: stop,
      participants: [],
      announcedAt,
    });
    expect(exactly[0]?.step).toBe("end-call");
  });

  it("closes at the exact stop millisecond, not one tick later", () => {
    const announcedAt = new Date(
      at("2026-08-01T13:58:00.000Z").getTime() - HARD_CLOSE_ESCALATION_MS,
    );
    const atTheStop = planHardClose({
      now: stop,
      hardStopAt: stop,
      participants: [],
      announcedAt,
    });
    // `msToStop === 0` is the stop, not "not yet": a strict `<` here defers the
    // close by a tick and the room keeps running past a deadline we announced.
    expect(atTheStop[0]?.step).toBe("end-call");
  });

  it("says the room is empty rather than warning nobody", () => {
    const steps = planHardClose({
      now: at("2026-08-01T13:59:30.000Z"),
      hardStopAt: stop,
      participants: [],
      announcedAt: null,
    });
    expect(steps[0]?.step).toBe("announce");
    const notice = (steps[0] as { notice: { body: string } }).notice;
    expect(notice.body).toContain("room is empty");
  });

  it("respects a warning boundary that is not two minutes", () => {
    // A stop two seconds out still announces — the threshold is a duration,
    // not a schedule.
    const soon = new Date(at("2026-08-01T14:00:00.000Z").getTime() + 2_000);
    expect(
      planHardClose({
        now: soon,
        hardStopAt: at("2026-08-01T14:00:00.000Z"),
        participants: [],
        announcedAt: null,
      })[0]?.step,
    ).toBe("announce");
  });
});

describe("the ladder never invents a stop it cannot hold", () => {
  it("uses a caller-supplied cap when given one", () => {
    const l = ladder(at("2026-08-01T13:58:00.000Z"), {
      hardStopAt: at("2026-08-01T14:10:00.000Z"),
    });
    expect(l.hardStopAt).toEqual(at("2026-08-01T14:10:00.000Z"));
    // Ten minutes out is not the announcement window.
    expect(l.rung).not.toBe("hard-close-warning");
  });

  it("warns at cap-2 of whatever cap it was given", () => {
    const cap = at("2026-08-01T15:00:00.000Z");
    expect(
      ladder(at("2026-08-01T14:57:59.999Z"), { hardStopAt: cap }).rung,
    ).toBe("grace-expired");
    expect(
      ladder(at("2026-08-01T14:58:00.000Z"), { hardStopAt: cap }).rung,
    ).toBe("hard-close-warning");
  });
});

describe("the ladder's constants are the ones the issue specifies", () => {
  it("bills in 15-minute blocks with a 10-minute grace and a 5-minute warning", () => {
    // Free grace is 10 minutes FOR BILLING ONLY. It is not `REJOIN_GRACE_MS`
    // or `CALL_DURATION_GRACE_MS`, which protect a reconnect — shrinking those
    // to match would lock a dropped participant out ten minutes early.
    expect(OVERRUN_GRACE_MS).toBe(10 * 60 * 1000);
    expect(OVERRUN_WARN_MS).toBe(5 * 60 * 1000);
    expect(EXTEND_BLOCK_MIN).toBe(15);
    expect(HARD_CLOSE_WARN_MS).toBe(2 * 60 * 1000);
    // The fallback stop is the join backstop, not the billing grace.
    expect(OVERRUN_JOIN_BACKSTOP_MS).toBe(30 * 60 * 1000);
    expect(OVERRUN_JOIN_BACKSTOP_MS).toBeGreaterThan(OVERRUN_GRACE_MS);
  });
});
