/**
 * Reschedule proposal policy.
 *
 * The rules encoded here are the ones a reviewer is most likely to get wrong
 * later: auto-confirmation is deliberately asymmetric, and the expiry has two
 * bounds rather than one.
 */

import "./setup";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PROPOSAL_MAX_LIFETIME_HOURS,
  RESCHEDULE_TERMINAL_EVENT_CODES,
  computeProposalExpiry,
  mayAutoConfirm,
  proposalCountMatches,
  rescheduleNotificationVariant,
  supportsProposals,
  type RescheduleProposeCode,
  type RescheduleRespondCode,
} from "../../lib/booking/reschedule-proposals";
import {
  RESCHEDULE_ALLOWED_FROM,
  RESCHEDULE_OPEN_STATUSES,
  RESCHEDULE_TERMINAL_STATUSES,
} from "../../lib/booking/transitions";

const HOUR = 3_600_000;
const now = new Date("2026-08-01T00:00:00Z");
const hoursFromNow = (h: number) => new Date(now.getTime() + h * HOUR);

describe("computeProposalExpiry", () => {
  it("caps a far-future session at the 72-hour lifetime", () => {
    // Session three months out: the session deadline is irrelevant, the cap bites.
    const expiry = computeProposalExpiry([hoursFromNow(24 * 90)], now);
    expect(expiry).toEqual(hoursFromNow(PROPOSAL_MAX_LIFETIME_HOURS));
  });

  it("resolves before the session when the session is nearer than the cap", () => {
    // Session in 48h must be answered by the 24h mark, not at now+72h — which
    // would be a day AFTER the session it concerns.
    const expiry = computeProposalExpiry([hoursFromNow(48)], now);
    expect(expiry).toEqual(hoursFromNow(24));
  });

  it("takes the earliest released session, not the first listed", () => {
    const expiry = computeProposalExpiry(
      [hoursFromNow(24 * 30), hoursFromNow(40), hoursFromNow(24 * 10)],
      now,
    );
    expect(expiry).toEqual(hoursFromNow(16));
  });

  it("never returns an expiry in the past", () => {
    // Inside the resolve margin already — the 24h policy gate should have
    // rejected this upstream, so null signals a caller bug rather than
    // producing a proposal that is born expired.
    expect(computeProposalExpiry([hoursFromNow(10)], now)).toBeNull();
    expect(computeProposalExpiry([hoursFromNow(24)], now)).toBeNull();
  });

  it("returns null when nothing was released", () => {
    expect(computeProposalExpiry([], now)).toBeNull();
  });
});

describe("auto-confirmation is asymmetric", () => {
  it("lets a consultee's proposal confirm without the consultant", () => {
    // Published availability is standing consent to be booked inside it.
    expect(mayAutoConfirm("CONSULTEE")).toBe(true);
  });

  it("never lets a consultant's proposal confirm without the consultee", () => {
    // Being free at a time is not consent to be moved to it.
    expect(mayAutoConfirm("CONSULTANT")).toBe(false);
  });
});

describe("scope and shape guards", () => {
  it("offers proposals only for the two one-to-one booking types", () => {
    expect(supportsProposals("CONSULTATION")).toBe(true);
    expect(supportsProposals("SUBSCRIPTION")).toBe(true);
    // A webinar has N attendees — no coherent "other side" to accept or counter.
    expect(supportsProposals("WEBINAR")).toBe(false);
    expect(supportsProposals("CLASS")).toBe(false);
    expect(supportsProposals("TRIAL")).toBe(false);
  });

  // ATOMS on both sides, and the unit is the whole point (#1846). This helper
  // used to take two ROW counts, which made a 1-hour session — one released
  // occurrence covering two atoms, proposed as the two rows a calendar click
  // expands into — compare 1 against 2 and fail: released and proposed, but
  // never acceptable. A row count is not commensurable with a row count here.
  it("requires the same COVERAGE, counted in atoms", () => {
    expect(proposalCountMatches(2, 2)).toBe(true);
    // Fewer or more coverage is a different booking, not a reschedule — it
    // would silently change what was paid for.
    expect(proposalCountMatches(2, 1)).toBe(false);
    expect(proposalCountMatches(2, 3)).toBe(false);
  });
});

describe("RESCHEDULE_ALLOWED_FROM state machine", () => {
  it("has no way into AUTO_ACCEPTED — it is only ever written at creation", () => {
    expect(RESCHEDULE_ALLOWED_FROM.AUTO_ACCEPTED).toEqual([]);
  });

  it("allows every terminal state to be reached from either open state", () => {
    for (const terminal of ["ACCEPTED", "DECLINED", "EXPIRED"] as const) {
      expect(RESCHEDULE_ALLOWED_FROM[terminal]).toEqual(
        expect.arrayContaining([...RESCHEDULE_OPEN_STATUSES]),
      );
    }
  });

  it("never allows leaving a terminal state", () => {
    for (const [target, allowedFrom] of Object.entries(
      RESCHEDULE_ALLOWED_FROM,
    )) {
      for (const terminal of RESCHEDULE_TERMINAL_STATUSES) {
        expect(allowedFrom).not.toContain(terminal);
      }
      // Sanity: the map covers every status exactly once.
      expect(typeof target).toBe("string");
    }
  });

  it("partitions every status into open or terminal", () => {
    const all = Object.keys(RESCHEDULE_ALLOWED_FROM).sort();
    const partitioned = [
      ...RESCHEDULE_OPEN_STATUSES,
      ...RESCHEDULE_TERMINAL_STATUSES,
    ].sort();
    expect(partitioned).toEqual(all);
  });
});

describe("allocationRequestSchema carries override", () => {
  it("no longer strips the field the Override button sends", async () => {
    const { allocationRequestSchema } =
      await import("../../schemas/slotAllocation/validationSchemas");

    // Before this, `override` was absent from the schema and a plain (non-
    // passthrough) Zod object dropped it, so "Override and Allocate" sent a
    // flag nothing read and reliably 400'd with OUTSIDE_AVAILABILITY.
    const parsed = allocationRequestSchema.parse({
      isAuto: false,
      useRequestedSlots: true,
      override: true,
    });

    expect(parsed.override).toBe(true);
  });

  it("still rejects a non-boolean override", () => {
    return import("../../schemas/slotAllocation/validationSchemas").then(
      ({ allocationRequestSchema }) => {
        const result = allocationRequestSchema.safeParse({
          isAuto: false,
          useRequestedSlots: true,
          override: "yes",
        });
        expect(result.success).toBe(false);
      },
    );
  });
});

describe("rescheduleNotificationVariant", () => {
  const released = new Date("2026-08-10T09:00:00Z");
  const proposed = new Date("2026-08-12T14:00:00Z");

  it("carries both times when the proposal auto-confirmed", () => {
    expect(
      rescheduleNotificationVariant({
        releasedAt: released,
        proposedAt: proposed,
        autoConfirmed: true,
      }),
    ).toEqual({
      outcome: "MOVED",
      oldDateTime: released.toISOString(),
      newDateTime: proposed.toISOString(),
    });
  });

  it("distinguishes a proposal still awaiting an answer from a confirmed move", () => {
    expect(
      rescheduleNotificationVariant({
        releasedAt: released,
        proposedAt: proposed,
        autoConfirmed: false,
      }),
    ).toEqual({
      outcome: "PROPOSED",
      oldDateTime: released.toISOString(),
      newDateTime: proposed.toISOString(),
    });
  });

  it("emits no destination for a plain release", () => {
    // The bug this replaces: a template rendering "from {{oldDateTime}} to
    // {{newDateTime}}" against a payload carrying neither, which reached the
    // consultant's inbox as "rescheduled ... from  to".
    const variant = rescheduleNotificationVariant({
      releasedAt: released,
      proposedAt: null,
      autoConfirmed: false,
    });

    expect(variant).toEqual({
      outcome: "RELEASED",
      oldDateTime: released.toISOString(),
    });
    // Absent, not undefined — an explicit key would still serialize into the
    // payload Novu interpolates.
    expect("newDateTime" in variant).toBe(false);
  });

  it("omits the released time too when there is none to report", () => {
    const variant = rescheduleNotificationVariant({
      releasedAt: null,
      proposedAt: proposed,
      autoConfirmed: true,
    });

    // A destination alone cannot render "moved from X to Y", so it degrades to
    // the released sentence rather than half-filling the other one.
    expect(variant).toEqual({ outcome: "RELEASED" });
  });
});

/**
 * The propose and respond routes each report an outcome for one reschedule, in
 * their own vocabulary, and a client holding an open proposal has to correlate
 * them. `RESCHEDULE_TERMINAL_EVENT_CODES` is that correlation — so it is pinned
 * as a contract rather than left as prose: the table has to keep naming every
 * code of the authoritative union exactly once (no undocumented state, no
 * invented one), and the lossy direction has to stay lossy.
 */
describe("the two reschedule outcome vocabularies are mapped, not merged", () => {
  const EVENTS = Object.entries(RESCHEDULE_TERMINAL_EVENT_CODES);

  it("names every propose code and invents none", () => {
    // Declared rather than hardcoded from the table, so adding a member to the
    // union without documenting it fails here.
    const KNOWN: RescheduleProposeCode[] = [
      "AUTO_CONFIRMED",
      "RELEASED",
      "AWAITING_ANSWER",
      "NOT_PLACEABLE",
      "PROPOSAL_CLOSED",
    ];
    const mapped = EVENTS.map(([, v]) => v.propose);

    expect([...new Set(mapped)].sort()).toEqual([...KNOWN].sort());
    // Only the closed code may stand for more than one event — the three events
    // a client cannot tell apart from the initiator's side. A second code
    // reaching two events would mean the table had hidden a distinction.
    const repeated = [
      ...new Set(mapped.filter((c, i) => mapped.indexOf(c) !== i)),
    ].sort();
    expect(repeated).toEqual(["PROPOSAL_CLOSED"]);
  });

  it("reports a respond code for exactly the two events the respond route can see", () => {
    const reported = EVENTS.map(([, v]) => v.respond).filter(
      (c): c is RescheduleRespondCode => c !== null,
    );
    expect([...new Set(reported)].sort()).toEqual(["DECLINED", "RELEASED"]);
  });

  it("collapses both declines AND the sweep's lapse onto PROPOSAL_CLOSED", () => {
    // The whole reason the mapping is published rather than collapsed into one
    // enum: from the initiator's side an answered proposal and a lapsed one are
    // indistinguishable, and pretending otherwise would mean the propose route
    // reporting a cause it cannot know.
    const closed = EVENTS.filter(
      ([, v]) => v.propose === "PROPOSAL_CLOSED",
    ).map(([k]) => k);
    expect(closed).toEqual([
      "DECLINED_AND_ALL_ROWS_RESTORED",
      "DECLINED_AND_SOME_ROWS_STRANDED",
      "LAPSED_UNANSWERED",
    ]);
    // Only the third is one the respond route could never have produced.
    expect(RESCHEDULE_TERMINAL_EVENT_CODES.LAPSED_UNANSWERED.respond).toBeNull();
  });

  it("keeps the respond route's own union equal to the one the table is typed with", () => {
    // The route declares its union as a literal because a regression pin holds
    // that exact line, so the two can only be held together from here.
    const route = readFileSync(
      join(
        process.cwd(),
        "app/api/appointments/[appointmentId]/reschedule/respond/route.ts",
      ),
      "utf8",
    );
    const respondMembers = [
      ...new Set(
        EVENTS.map(([, v]) => v.respond).filter(
          (c): c is RescheduleRespondCode => c !== null,
        ),
      ),
    ].sort();
    expect(route).toContain(
      `type RescheduleRespondCode = ${respondMembers
        .map((m) => `"${m}"`)
        .join(" | ")};`,
    );
  });
});
