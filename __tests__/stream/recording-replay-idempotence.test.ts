/**
 * @jest-environment node
 */

/**
 * #C5 / #C6 — the recording handlers are re-driven, so "already done" has to be
 * enforced by the DATABASE.
 *
 * This is not a theoretical hazard. `logWebhookEvent` stores the payload and
 * `sweep-stuck-webhook-events` re-drives any row carrying an error for 168
 * hours, and Stream itself redelivers. Both handlers here wrote a row per
 * delivery:
 *
 *   - `recording_failed` did `findFirst` then `create` (C5). There was no
 *     constraint behind the check: a failed recording has no filename, so
 *     `streamRecordingId` was left null and the column's `@unique` could not
 *     dedupe anything. Two deliveries both read "no FAILED row" and both wrote
 *     one — and the notification fan-out below ran on BOTH, mailing every seat
 *     holder of the booking the same "we could not record your session" again,
 *     once per re-drive, for three days.
 *   - `recording_ready` had the same check-then-act shape (C6). Its unique DID
 *     dedupe the row, but the loser raised P2002 into a generic catch, so the
 *     event was stamped failed, re-driven, and raced again — churning for the
 *     full give-up window on work that had already succeeded.
 *
 * The fix in both cases is the same posture `lib/webhooks/event-log.ts:195` takes:
 * a unique violation here means "someone already wrote what I was writing", never
 * "this is a bug". For `recording_failed` it additionally means the value written
 * has to be deterministic, which is what the `failed:` key is for.
 */

const mockMeetingFindUnique = jest.fn();
const mockMeetingUpdateMany = jest.fn();
const mockRecordingCreate = jest.fn();
const mockRecordingFindFirst = jest.fn();
const mockNotifyFailed = jest.fn();
const mockNotifyAvailable = jest.fn();
const mockTransfer = jest.fn();
const mockGetEventAttendeeIds = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: (...a: unknown[]) => mockMeetingFindUnique(...a),
      updateMany: (...a: unknown[]) => mockMeetingUpdateMany(...a),
    },
    recording: {
      create: (...a: unknown[]) => mockRecordingCreate(...a),
      findFirst: (...a: unknown[]) => mockRecordingFindFirst(...a),
    },
  },
}));

jest.mock("../../lib/novu/service", () => ({
  notifyRecordingFailed: (...a: unknown[]) => mockNotifyFailed(...a),
  notifyRecordingAvailable: (...a: unknown[]) => mockNotifyAvailable(...a),
}));

jest.mock("../../lib/stream/recording-utils", () => ({
  generateRecordingTitle: () => "A recorded session",
  getEventAttendeeIds: (...a: unknown[]) => mockGetEventAttendeeIds(...a),
}));

jest.mock("../../lib/stream/recording-transfer-service", () => ({
  RecordingTransferService: {
    queueRecordingTransfer: (...a: unknown[]) => mockTransfer(...a),
  },
}));

jest.mock("../../lib/novu", () => ({
  attemptTrigger: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/novu/workflows", () => ({
  notificationScope: () => ({}),
}));

jest.mock("../../lib/novu/resolve-href", () => ({
  notificationHref: () => "/dashboard/recordings",
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/** A unique violation as Prisma raises one. */
const p2002 = () =>
  Object.assign(new Error("Unique constraint failed on the fields"), {
    code: "P2002",
  });

const MEETING = {
  id: "ms-1",
  isRecording: true,
  recordingStartedAt: null,
  recordingStartedBy: null,
  occurrence: {
    appointment: {
      id: "appt-1",
      organizationId: "org-1",
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
    },
  },
};

const failedEvent = (created_at: string) => ({
  call_cid: "default:occurrence-ms-1",
  type: "call.recording_failed" as const,
  error: { message: "egress failed", code: "16" },
  created_at,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMeetingFindUnique.mockResolvedValue(MEETING);
  mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
  mockRecordingFindFirst.mockResolvedValue(null);
  mockRecordingCreate.mockResolvedValue({ id: "rec-1" });
  mockGetEventAttendeeIds.mockResolvedValue(["user-a", "user-b"]);
  mockNotifyFailed.mockResolvedValue(undefined);
  mockNotifyAvailable.mockResolvedValue([]);
  mockTransfer.mockResolvedValue(undefined);
});

describe("recording_failed is idempotent, and the bell fires once (C5)", () => {
  it("records the failure under a DETERMINISTIC id, so the unique can fence it", async () => {
    const { handleRecordingFailed } =
      await import("../../lib/stream/recording-handlers");

    await handleRecordingFailed(failedEvent("2026-09-13T11:20:00.000Z"));

    const { data } = mockRecordingCreate.mock.calls[0][0];
    // The point of the whole fix. `streamRecordingId` was null before, which is
    // exactly why nothing could dedupe two deliveries of one failure: a failed
    // recording has no filename to key on. The call plus the EVENT's own
    // `created_at` is stable across every re-drive (the sweeper replays the
    // stored payload rather than re-fetching from Stream), and the `failed:`
    // prefix namespaces it away from a real Stream filename so nothing that
    // looks up "a recording we already have" mistakes this row for a segment.
    expect(data.streamRecordingId).toBe(
      "failed:occurrence-ms-1@2026-09-13T11:20:00.000Z",
    );
    // Also the event's clock rather than the processing clock: "when the
    // recording failed" is a fact about the call.
    expect(data.recordedAt).toEqual(new Date("2026-09-13T11:20:00.000Z"));
    expect(data.status).toBe("FAILED");
  });

  it("notifies the room once, and returns before the fan-out on a re-drive", async () => {
    const { handleRecordingFailed } =
      await import("../../lib/stream/recording-handlers");

    await handleRecordingFailed(failedEvent("2026-09-13T11:20:00.000Z"));
    expect(mockNotifyFailed).toHaveBeenCalledTimes(2); // two seat holders

    // The same event, delivered again by the sweeper.
    mockRecordingCreate.mockRejectedValueOnce(p2002());

    await expect(
      handleRecordingFailed(failedEvent("2026-09-13T11:20:00.000Z")),
    ).resolves.toBeUndefined();

    // The early return is the assertion: no second round of emails, and the
    // handler does not fall through to do the work again.
    expect(mockNotifyFailed).toHaveBeenCalledTimes(2);
  });

  it("keeps a genuinely SECOND failure in the same call as its own row", async () => {
    // Record, fail, record, fail. Deduping on the call alone would throw the
    // second failure away; the event time is what distinguishes them.
    const { handleRecordingFailed } =
      await import("../../lib/stream/recording-handlers");

    await handleRecordingFailed(failedEvent("2026-09-13T11:20:00.000Z"));
    await handleRecordingFailed(failedEvent("2026-09-13T12:40:00.000Z"));

    expect(mockRecordingCreate).toHaveBeenCalledTimes(2);
    expect(mockNotifyFailed).toHaveBeenCalledTimes(4);
  });

  it("still propagates a create failure that is not a unique violation", async () => {
    // Adopting P2002 must not become a blanket "swallow the error": a dead
    // connection has to reach the catch so the event is stamped and re-driven.
    const { handleRecordingFailed } =
      await import("../../lib/stream/recording-handlers");

    mockRecordingCreate.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      handleRecordingFailed(failedEvent("2026-09-13T11:20:00.000Z")),
    ).rejects.toThrow("connection reset");
    expect(mockNotifyFailed).not.toHaveBeenCalled();
  });

  it("clears isRecording through a compare-and-set, not a bare update", async () => {
    const { handleRecordingFailed } =
      await import("../../lib/stream/recording-handlers");

    await handleRecordingFailed(failedEvent("2026-09-13T11:20:00.000Z"));

    expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
      where: { id: "ms-1", isRecording: true },
      data: { isRecording: false },
    });
  });
});

describe("recording_ready adopts the row a concurrent delivery wrote (C6)", () => {
  const readyEvent = {
    call_cid: "default:occurrence-ms-1",
    type: "call.recording_ready" as const,
    call_recording: {
      filename: "occurrence-ms-1-1705060800000-ab12cd34.mp4",
      url: "https://stream.test/recording.mp4",
      start_time: "2026-09-13T11:00:00.000Z",
      end_time: "2026-09-13T11:45:00.000Z",
    },
    created_at: "2026-09-13T11:50:00.000Z",
  };

  it("swallows P2002 and returns, instead of failing the delivery", async () => {
    const { handleRecordingReady } =
      await import("../../lib/stream/recording-handlers");

    // The race this pins is between the handler's own courtesy `findFirst` and
    // its `create` — so the pre-check must come back EMPTY and only the adoption
    // read after the violation may find the winner's row.
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "rec-existing" });
    mockRecordingCreate.mockRejectedValueOnce(p2002());

    await expect(handleRecordingReady(readyEvent)).resolves.toBeUndefined();

    // And it returns before the notification fan-out, which is the same rule the
    // failure handler now follows: the write happened once, so the bell rings
    // once.
    expect(mockNotifyAvailable).not.toHaveBeenCalled();
  });

  it("re-reads the winning row by the same keys the unique covers", async () => {
    const { handleRecordingReady } =
      await import("../../lib/stream/recording-handlers");

    mockRecordingCreate.mockRejectedValueOnce(p2002());
    // First read is the handler's own courtesy `findFirst` (nothing there yet);
    // the second is the adoption read after the unique violation.
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "rec-existing" });

    await handleRecordingReady(readyEvent);

    expect(mockRecordingFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          meetingId: "ms-1",
          streamRecordingId: "occurrence-ms-1-1705060800000-ab12cd34.mp4",
        },
      }),
    );
  });

  it("still throws when the violation is not ours to adopt", async () => {
    const { handleRecordingReady } =
      await import("../../lib/stream/recording-handlers");

    mockRecordingCreate.mockRejectedValueOnce(new Error("disk full"));

    await expect(handleRecordingReady(readyEvent)).rejects.toThrow("disk full");
  });

  it("clears isRecording with the value it read in the where clause (C4)", async () => {
    const { handleRecordingReady } =
      await import("../../lib/stream/recording-handlers");

    await handleRecordingReady(readyEvent);

    expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
      where: { id: "ms-1", isRecording: true },
      data: { isRecording: false },
    });
  });
});
