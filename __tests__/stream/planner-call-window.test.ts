/**
 * @jest-environment node
 */

/**
 * #C7 — a planner time edit has to reach Stream, or the SFU ends a paid
 * consultation early.
 *
 * `replaceOccurrence` rewrites the occurrence IN PLACE (correctly — `Meeting` and
 * `Recording` cascade on occurrence delete, so a duration edit must not cost a
 * host their recordings), and it used to do that silently. But the Stream call
 * is a second description of the same session, and nothing told it:
 *
 *   - `custom.sessionStartsAt` / `sessionEndsAt` / `sessionDurationMinutes`, which
 *     the meeting screens render; and
 *   - `settings_override.limits.max_duration_seconds` — the SFU's own hard stop,
 *     computed in lib/meetings/duration-cap.ts and counting from FIRST JOIN.
 *
 * So a 60-minute consultation extended to four hours kept a cap of about 105
 * minutes, and Stream terminated the call roughly 135 minutes before its booked
 * end, mid-session, for everyone in the room. The database said four hours and
 * the SFU said one hour and forty-five, and nothing in the app could see the
 * disagreement until the room died.
 *
 * The two halves of the fix are pinned here, separately, because they are
 * separate decisions:
 *
 *   1. `replaceOccurrence` REPORTS the move (no Stream import in a pure
 *      scheduling module, and never a provider call inside the caller's open
 *      Serializable transaction).
 *   2. `syncCallWindowForOccurrence` applies it AFTER the commit, and merges into
 *      the call's existing `custom` rather than sending a partial object — Stream
 *      REPLACES `custom` wholesale, so a partial write would delete
 *      `consultantUserId` and `hostUserIds`, which are what the meeting UI
 *      derives "End for everyone" from.
 */

const mockMeetingFindUnique = jest.fn();
const mockCallGet = jest.fn();
const mockCallUpdate = jest.fn();
let mockStreamConfigured = true;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => mockStreamConfigured,
  withStreamCircuitBreaker: <T>(fn: () => T | Promise<T>) => fn(),
  getStreamVideoClient: () => ({
    video: {
      call: (_type: string, id: string) => ({
        id,
        get: () => mockCallGet(),
        update: (payload: unknown) => mockCallUpdate(payload),
      }),
    },
  }),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { syncCallWindowForOccurrence } from "../../lib/meetings/sync-call-window";
import { replaceOccurrence } from "../../lib/appointments/occurrences";

/** What the call looks like after the mint: the keys the merge must preserve. */
const EXISTING_CUSTOM = {
  title: "CONSULTATION with Ada",
  occurrenceId: "occ-1",
  appointmentId: "appt-1",
  organizationId: "org-1",
  consultantUserId: "user-consultant",
  hostUserIds: ["user-consultant"],
  sessionStartsAt: "2026-09-13T10:00:00.000Z",
  sessionEndsAt: "2026-09-13T11:00:00.000Z",
  sessionDurationMinutes: 60,
};

const OCCURRENCE = {
  id: "occ-1",
  startsAt: new Date("2026-09-13T10:00:00.000Z"),
  endsAt: new Date("2026-09-13T14:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStreamConfigured = true;
  mockMeetingFindUnique.mockResolvedValue({
    id: "ms-1",
    streamCallId: "occurrence-occ-1",
  });
  mockCallGet.mockResolvedValue({ call: { custom: { ...EXISTING_CUSTOM } } });
  mockCallUpdate.mockResolvedValue({});
});

describe("syncCallWindowForOccurrence re-stamps the call (C7)", () => {
  it("finds the room by OCCURRENCE, not by the call id", async () => {
    await syncCallWindowForOccurrence(OCCURRENCE);

    // `streamCallId` is the value that can be stale — a #1607 rebuild rebinds it
    // — while `appointmentOccurrenceId` is `@unique` and survives.
    expect(mockMeetingFindUnique).toHaveBeenCalledWith({
      where: { appointmentOccurrenceId: "occ-1" },
      select: { id: true, streamCallId: true },
    });
  });

  it("merges into the call's own custom instead of replacing it", async () => {
    await syncCallWindowForOccurrence(OCCURRENCE);

    const { custom } = mockCallUpdate.mock.calls[0][0];
    expect(custom).toMatchObject({
      // The three keys the planner moved.
      sessionStartsAt: "2026-09-13T10:00:00.000Z",
      sessionEndsAt: "2026-09-13T14:00:00.000Z",
      sessionDurationMinutes: 240,
      // …and everything else it did not. A partial `custom` would have been
      // REPLACED by Stream, taking `consultantUserId` with it and leaving the
      // host — and therefore "End for everyone" — unidentified in the room.
      consultantUserId: "user-consultant",
      hostUserIds: ["user-consultant"],
      organizationId: "org-1",
      occurrenceId: "occ-1",
    });
  });

  it("widens the SFU's hard stop to the new booked length", async () => {
    await syncCallWindowForOccurrence(OCCURRENCE);

    const { settings_override } = mockCallUpdate.mock.calls[0][0];
    const cap = settings_override.limits
      .max_duration_seconds as unknown as number;
    // Four hours plus the consultant's 15-minute early window and the 30-minute
    // rejoin grace (lib/meetings/duration-cap.ts). The failure this prevents is
    // the stale ~105 minutes ending the session two hours and fifteen minutes
    // early.
    expect(cap).toBe((4 * 60 + 45) * 60);
    expect(cap).toBeGreaterThan(4 * 60 * 60);
  });

  it("is a no-op for a booking that has never been joined", async () => {
    // The room is minted lazily on the first join, from these same times, so
    // there is nothing stale to correct.
    mockMeetingFindUnique.mockResolvedValue(null);

    await expect(syncCallWindowForOccurrence(OCCURRENCE)).resolves.toEqual({
      updated: false,
      reason: "no_meeting",
    });
    expect(mockCallUpdate).not.toHaveBeenCalled();
  });

  it("logs and reports a Stream failure instead of throwing", async () => {
    // The row is already committed by the time this runs. Throwing would tell
    // the planner their save failed when it succeeded, and could not undo it.
    mockCallGet.mockRejectedValue(new Error("stream 500"));

    await expect(syncCallWindowForOccurrence(OCCURRENCE)).resolves.toEqual({
      updated: false,
      reason: "stream_error",
    });
  });
});

describe("replaceOccurrence reports the move without touching Stream (C7)", () => {
  /**
   * The smallest `PrismaLike` `replaceOccurrence` needs: the live row it moves,
   * and enough of the earnings-hold recompute it always runs (which reads the
   * appointment and, when it has no succeeded payment, stops there).
   */
  function fakeTx(existing: Array<Record<string, unknown>>) {
    const update = jest.fn(async () => undefined);
    return {
      update,
      client: {
        appointmentOccurrence: {
          findMany: async () => existing,
          update,
          create: jest.fn(),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        appointment: {
          findUnique: async () => ({
            appointmentType: "CONSULTATION",
            payment: [],
          }),
        },
      } as never,
    };
  }

  const live = (startsAt: string, endsAt: string) => ({
    id: "occ-1",
    appointmentId: "appt-1",
    ordinal: 1,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    durationInHours: 1,
    isTentative: false,
    consultantProfileId: "cp-1",
    completionStatus: "SCHEDULED",
    deletedAt: null,
    updatedAt: new Date(startsAt),
  });

  it("returns the window it moved FROM, so the caller can tell Stream", async () => {
    const { client } = fakeTx([
      live("2026-09-13T10:00:00.000Z", "2026-09-13T11:00:00.000Z"),
    ]);

    const result = await replaceOccurrence(client, {
      appointmentId: "appt-1",
      startsAt: new Date("2026-09-13T10:00:00.000Z"),
      durationInHours: 4,
      consultantProfileId: "cp-1",
    });

    expect(result).toEqual({
      occurrenceId: "occ-1",
      movedFrom: {
        startsAt: new Date("2026-09-13T10:00:00.000Z"),
        endsAt: new Date("2026-09-13T11:00:00.000Z"),
      },
    });
  });

  it("reports no move for a re-save of the same window, so nothing is written", async () => {
    const { client, update } = fakeTx([
      live("2026-09-13T10:00:00.000Z", "2026-09-13T11:00:00.000Z"),
    ]);

    const result = await replaceOccurrence(client, {
      appointmentId: "appt-1",
      startsAt: new Date("2026-09-13T10:00:00.000Z"),
      durationInHours: 1,
      consultantProfileId: "cp-1",
    });

    // The planner client re-sends `scheduledAt` on every save, including for a
    // title-only edit. Reporting a move here would rewrite a correct call.
    expect(result.movedFrom).toBeNull();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ movedAt: expect.anything() }),
      }),
    );
  });
});
