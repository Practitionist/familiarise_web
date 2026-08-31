/**
 * @jest-environment node
 */

/**
 * #1280 — the server-side call duration cap, as a billing backstop.
 *
 * The one thing that must never happen here is a cap SHORT enough to end a paid
 * session. #1144 recorded this feature as ending calls "at the slot boundary";
 * #1160 corrected that, and the correction is the whole design: Stream's timer
 * counts from the moment the FIRST PARTICIPANT JOINS, not from `starts_at`. Set
 * to the booked length, a consultant arriving fifteen minutes early to check
 * their camera would have the SFU hard-terminate the session before the booked
 * end, ejecting both parties mid-sentence.
 *
 * So every case below is about the cap being generous enough, and the ceiling
 * existing only so a corrupt booking cannot disable the bound entirely.
 */

// No mocks needed: the resolver lives in its own module with no Prisma and no
// Stream client behind it. That is why it was extracted out of the server
// action — and jest.mock() needs relative paths here anyway, because the `@/`
// alias resolves to a different module instance and the mock silently does not
// bind.
import { resolveMaxCallDurationSeconds } from "../../lib/meetings/duration-cap";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  DEFAULT_MEETING_DURATION_MS,
} from "../../lib/appointments/slots";

const MIN = 60;
const start = new Date("2026-09-01T10:00:00Z");
const after = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

describe("resolveMaxCallDurationSeconds", () => {
  it("always leaves room for the earliest legitimate arrival", () => {
    // The consultant may be in the room CONSULTANT_JOIN_WINDOW_MS before the
    // booked start, and the clock starts when they arrive. A cap that did not
    // cover that window would eat the end of the session.
    const booked = 120;
    const cap = resolveMaxCallDurationSeconds({ endsAt: after(booked) }, start);

    expect(cap * 1000).toBeGreaterThanOrEqual(
      booked * MIN * 1000 + CONSULTANT_JOIN_WINDOW_MS,
    );
  });

  it("never expires while the server would still allow a rejoin", () => {
    // `lib/meetings/access.ts` admits a rejoin for 30 minutes past the
    // scheduled end. A cap firing inside that window would refuse the
    // reconnection the join gate had just authorised.
    const booked = 120;
    const cap = resolveMaxCallDurationSeconds({ endsAt: after(booked) }, start);

    expect(cap).toBeGreaterThanOrEqual((booked + 15 + 30) * MIN);
  });

  it("is NOT the booked duration — the thing #1160 corrected", () => {
    const booked = 60;
    const cap = resolveMaxCallDurationSeconds({ endsAt: after(booked) }, start);

    expect(cap).toBeGreaterThan(booked * MIN);
  });

  it("floors a short or zero-length run rather than trusting it", () => {
    // A cap derived from bad data must fail long, not short.
    const zero = resolveMaxCallDurationSeconds({ endsAt: start }, start);
    const inverted = resolveMaxCallDurationSeconds(
      { endsAt: after(-60) },
      start,
    );

    expect(zero).toBeGreaterThanOrEqual(2 * 60 * MIN);
    expect(inverted).toBeGreaterThanOrEqual(2 * 60 * MIN);
  });

  it("falls back to the default booking length with no profile", () => {
    const cap = resolveMaxCallDurationSeconds(null, start);

    expect(cap * 1000).toBeGreaterThanOrEqual(DEFAULT_MEETING_DURATION_MS);
  });

  it("caps an absurd booking rather than disabling the bill bound", () => {
    // The ceiling is not about correctness of the booking, it is about the cap
    // remaining finite. An unbounded meter is the failure this whole feature
    // exists to prevent.
    const cap = resolveMaxCallDurationSeconds(
      { endsAt: after(60 * 24 * 30) },
      start,
    );

    expect(cap).toBe(12 * 60 * MIN);
  });

  it("returns whole seconds", () => {
    // Stream's field is `max_duration_seconds`; a fractional value is a 400.
    const cap = resolveMaxCallDurationSeconds({ endsAt: after(37) }, start);
    expect(Number.isInteger(cap)).toBe(true);
  });
});
