/**
 * @jest-environment node
 */

/**
 * #1838 — who may buy more of a session.
 *
 * #1270 is the reason this file exists in its own right. Identity was once
 * treated as authorization inside the meeting subsystem, which let a valid
 * participant into a room days early, after cancellation, and into an unpaid
 * tentative booking, because every one of those rules lived only in React. An
 * extension is the same class of decision as "End for everyone": one person
 * decides for the room and decides what money moves.
 *
 * So the rule here is NOT "is this user the consultant". It is the existing
 * resolver's answer, narrowed to `host`. These tests pin that delegation: they
 * mock `resolveMeetingAccess` and assert the role gate, so a re-implementation
 * that reads the plan's consultant directly would fail rather than quietly
 * diverge from the join gate.
 */

const resolveMeetingAccess = jest.fn();
const findMeeting = jest.fn();

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...args: unknown[]) => resolveMeetingAccess(...args),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findUnique: (...args: unknown[]) => findMeeting(...args) },
  },
}));

import {
  mayAnswerExtensionPrompt,
  requireOverrunHost,
  type OverrunAuthority,
} from "../../lib/meetings/overrun-server";
import { resolveOverrunLadder } from "../../lib/meetings/overrun";

const CALL_ID = "slot-A";

type Grant = Extract<OverrunAuthority, { ok: true }>;

/**
 * Narrow a result to a grant, or fail loudly.
 *
 * A helper rather than an inline `if (result.ok)` so no assertion sits inside a
 * branch: a conditional `expect` silently stops running when the branch flips,
 * which is exactly the shape a regression would take here — the test would go
 * green while asserting nothing.
 */
function expectGrant(result: OverrunAuthority): Grant {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected a grant, got ${result.refusal}`);
  return result;
}

function granted(role: "host" | "participant") {
  return {
    hasAccess: true,
    role,
    message: "Access granted",
    reason: "granted" as const,
    streamCallId: CALL_ID,
    meetingId: "meeting-1",
    appointment: {},
  };
}

function meetingRow(over: Record<string, unknown> = {}) {
  return {
    id: "meeting-1",
    occurrence: {
      startsAt: new Date("2026-08-01T12:30:00.000Z"),
      endsAt: new Date("2026-08-01T13:30:00.000Z"),
      appointment: {
        trial: null,
        consultation: { consultationPlan: { price: 60_000 } },
        subscription: null,
        webinar: null,
        class: null,
      },
    },
    ...over,
  };
}

beforeEach(() => {
  findMeeting.mockReset();
  findMeeting.mockResolvedValue(meetingRow());
});

describe("only the host may extend", () => {
  it("refuses a participant, and asks the existing resolver first", async () => {
    resolveMeetingAccess.mockResolvedValue(granted("participant"));

    const result = await requireOverrunHost({
      callId: CALL_ID,
      userId: "consultee",
    });

    expect(result).toEqual({
      ok: false,
      refusal: "not_host",
      message: "Only the host can extend this session.",
    });
    // The gate is the resolver's, with the call id it resolves — never a local
    // re-derivation of "who is the consultant".
    expect(resolveMeetingAccess).toHaveBeenCalledWith(CALL_ID, "consultee");
    // And a refusal never goes on to price anything.
    expect(findMeeting).not.toHaveBeenCalled();
  });

  it("grants an accepted presenter, because they may already end the room", async () => {
    // `resolveMeetingAccess` returns `host` for an accepted collaborator whose
    // role is a presenter role — the same answer "End for everyone" keys on.
    resolveMeetingAccess.mockResolvedValue(granted("host"));

    const grant = expectGrant(
      await requireOverrunHost({ callId: CALL_ID, userId: "co-presenter" }),
    );

    expect(grant.meetingId).toBe("meeting-1");
    expect(grant.bookedEndsAt).toEqual(new Date("2026-08-01T13:30:00.000Z"));
    expect(grant.rate).toEqual({ planPricePaise: 60_000, bookedMinutes: 60 });
  });

  it("refuses someone the resolver could not admit at all", async () => {
    resolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    expect(
      await requireOverrunHost({ callId: CALL_ID, userId: "stranger" }),
    ).toMatchObject({ ok: false, refusal: "unauthorized" });
    expect(findMeeting).not.toHaveBeenCalled();
  });

  it("reports a missing meeting as not_found, not as a 403", async () => {
    resolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    });

    expect(
      await requireOverrunHost({ callId: CALL_ID, userId: "ghost" }),
    ).toMatchObject({ ok: false, refusal: "not_found" });
  });

  it("fails closed when the booking vanished between the two reads", async () => {
    resolveMeetingAccess.mockResolvedValue(granted("host"));
    findMeeting.mockResolvedValue(null);

    // The grant we are about to act on no longer has a booking behind it.
    expect(
      await requireOverrunHost({ callId: CALL_ID, userId: "host" }),
    ).toMatchObject({ ok: false, refusal: "not_found" });
  });
});

describe("an unpriceable booking sells nothing", () => {
  it("refuses when no plan carries a price", async () => {
    resolveMeetingAccess.mockResolvedValue(granted("host"));
    findMeeting.mockResolvedValue(
      meetingRow({
        occurrence: {
          startsAt: new Date("2026-08-01T12:30:00.000Z"),
          endsAt: new Date("2026-08-01T13:30:00.000Z"),
          appointment: {
            trial: null,
            consultation: { consultationPlan: null },
            subscription: null,
            webinar: null,
            class: null,
          },
        },
      }),
    );

    // A guessed price charged mid-call is worse than no extension at all.
    expect(
      await requireOverrunHost({ callId: CALL_ID, userId: "host" }),
    ).toMatchObject({ ok: false, refusal: "unpriceable" });
  });

  it("turns extension OFF for a trial, mirroring recording, without erroring", async () => {
    resolveMeetingAccess.mockResolvedValue(granted("host"));
    findMeeting.mockResolvedValue(
      meetingRow({
        occurrence: {
          startsAt: new Date("2026-08-01T12:30:00.000Z"),
          endsAt: new Date("2026-08-01T13:30:00.000Z"),
          appointment: {
            trial: { id: "t1" },
            consultation: { consultationPlan: null },
            subscription: null,
            webinar: null,
            class: null,
          },
        },
      }),
    );

    // Authorized, and simply not selling: a free introductory session is the
    // wrong place to introduce a paywall mid-call.
    const grant = expectGrant(
      await requireOverrunHost({ callId: CALL_ID, userId: "host" }),
    );
    expect(grant.extensionEnabled).toBe(false);
    expect(grant.rate).toBeNull();

    // And the ladder refuses on exactly that input.
    const ladder = resolveOverrunLadder({
      meetingId: "meeting-1",
      startsAt: new Date("2026-08-01T12:30:00.000Z"),
      bookedEndsAt: new Date("2026-08-01T13:30:00.000Z"),
      now: new Date("2026-08-01T13:40:00.000Z"),
      rate: null,
      extensionEnabled: false,
    });
    expect(ladder.rung).toBe("grace-expired");
    expect(ladder.canRequestBlock).toBe(false);
  });

  it("prices from a webinar plan when there is no consultation plan", async () => {
    resolveMeetingAccess.mockResolvedValue(granted("host"));
    findMeeting.mockResolvedValue(
      meetingRow({
        occurrence: {
          startsAt: new Date("2026-08-01T12:30:00.000Z"),
          endsAt: new Date("2026-08-01T13:30:00.000Z"),
          appointment: {
            trial: null,
            consultation: { consultationPlan: null },
            subscription: null,
            webinar: { webinarPlan: { price: 120_000 } },
            class: null,
          },
        },
      }),
    );

    const grant = expectGrant(
      await requireOverrunHost({ callId: CALL_ID, userId: "host" }),
    );
    expect(grant.rate).toEqual({ planPricePaise: 120_000, bookedMinutes: 60 });
    expect(grant.extensionEnabled).toBe(true);
  });
});

describe("the prompt-answering role", () => {
  it("follows the resolver's role rather than deciding its own", () => {
    expect(mayAnswerExtensionPrompt("host")).toBe(true);
    expect(mayAnswerExtensionPrompt("participant")).toBe(true);
    expect(mayAnswerExtensionPrompt(null)).toBe(false);
  });
});
