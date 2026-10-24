/**
 * @jest-environment node
 */

const mockRecording = {
  updateMany: jest.fn(),
  findMany: jest.fn(),
  updateManyAndReturn: jest.fn(),
};
const mockAuditCreate = jest.fn();
const mockOrgFindMany = jest.fn().mockResolvedValue([]);
jest.mock("../../lib/prisma", () => {
  const client = {
    organization: {
      findMany: (...args: unknown[]) => mockOrgFindMany(...args),
    },
    recording: {
      updateMany: (...args: unknown[]) => mockRecording.updateMany(...args),
      findMany: (...args: unknown[]) => mockRecording.findMany(...args),
      updateManyAndReturn: (...args: unknown[]) =>
        mockRecording.updateManyAndReturn(...args),
    },
    orgAuditLog: { create: (...args: unknown[]) => mockAuditCreate(...args) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));
const mockDeleteCopy = jest.fn();
jest.mock("../../lib/stream/recording-stream-delete", () => ({
  deleteStreamRecordingCopy: (...args: unknown[]) => mockDeleteCopy(...args),
}));

import { deleteRecordingAssets } from "../../lib/stream/recording-storage";
import { RecordingService } from "../../lib/stream/recording-service";
import { reportSentryMessage } from "../../lib/observability/report";
import {
  expireRecordings,
  recordingRetentionDeadline,
  type RetentionInput,
} from "../../lib/stream/recording-retention";

const NOW = new Date("2027-06-01T00:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const plusDays = (iso: string, days: number) =>
  new Date(day(iso).getTime() + days * 24 * 60 * 60 * 1000);

const input = (overrides: Partial<RetentionInput>): RetentionInput => ({
  now: NOW,
  recordedAt: day("2027-01-01"),
  session: { kind: "CONSULTATION", sessionEndedAt: day("2027-01-01") },
  published: false,
  hasLivePurchase: false,
  orgRetentionDays: null,
  ...overrides,
});

describe("recordingRetentionDeadline", () => {
  it("keeps a 1:1 consultation for 90 days after the session", () => {
    expect(recordingRetentionDeadline(input({}))).toEqual(
      plusDays("2027-01-01", 90),
    );
  });

  it("keeps a trial for 90 days after its session, like a 1:1", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "TRIAL", sessionEndedAt: day("2027-01-10") },
        }),
      ),
    ).toEqual(plusDays("2027-01-10", 90));
  });

  it("keeps subscription recordings until 90 days after the subscription ends", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: {
            kind: "SUBSCRIPTION",
            subscriptionEndsAt: day("2027-03-01"),
          },
        }),
      ),
    ).toEqual(plusDays("2027-03-01", 90));
  });

  it("has no deadline while the subscription is still active", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: {
            kind: "SUBSCRIPTION",
            subscriptionEndsAt: day("2027-09-01"),
          },
        }),
      ),
    ).toBeNull();
  });

  it("keeps a webinar for 365 days after the session", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "WEBINAR", sessionEndedAt: day("2027-01-01") },
        }),
      ),
    ).toEqual(plusDays("2027-01-01", 365));
  });

  it("keeps a class for 365 days after its final session, with no deadline while sessions remain", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "CLASS", lastSessionEndsAt: day("2027-02-01") },
        }),
      ),
    ).toEqual(plusDays("2027-02-01", 365));
    expect(
      recordingRetentionDeadline(
        input({
          session: { kind: "CLASS", lastSessionEndsAt: day("2027-07-01") },
        }),
      ),
    ).toBeNull();
  });

  it("caps at the org setting when it is shorter, and ignores it when longer", () => {
    expect(recordingRetentionDeadline(input({ orgRetentionDays: 30 }))).toEqual(
      plusDays("2027-01-01", 30),
    );
    expect(
      recordingRetentionDeadline(input({ orgRetentionDays: 400 })),
    ).toEqual(plusDays("2027-01-01", 90));
  });

  it("applies the org cap even while a subscription is active", () => {
    expect(
      recordingRetentionDeadline(
        input({
          session: {
            kind: "SUBSCRIPTION",
            subscriptionEndsAt: day("2027-09-01"),
          },
          orgRetentionDays: 60,
        }),
      ),
    ).toEqual(plusDays("2027-01-01", 60));
  });

  it("exempts published replays and live purchases, even under an org cap", () => {
    expect(
      recordingRetentionDeadline(
        input({ published: true, orgRetentionDays: 7 }),
      ),
    ).toBeNull();
    expect(
      recordingRetentionDeadline(
        input({ hasLivePurchase: true, orgRetentionDays: 7 }),
      ),
    ).toBeNull();
  });

  it("does not exempt a recording whose only purchases were refunded", () => {
    expect(
      recordingRetentionDeadline(input({ hasLivePurchase: false })),
    ).not.toBeNull();
  });

  it("uses only the platform schedule for personal recordings", () => {
    expect(
      recordingRetentionDeadline(
        input({
          orgRetentionDays: null,
          session: { kind: "WEBINAR", sessionEndedAt: day("2027-01-01") },
        }),
      ),
    ).toEqual(plusDays("2027-01-01", 365));
  });
});

describe("expireRecordings", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockRecording.findMany.mockReset().mockResolvedValue([]);
    mockRecording.updateMany.mockReset().mockResolvedValue({ count: 0 });
    mockDeleteCopy.mockReset().mockResolvedValue({ success: true });
    (reportSentryMessage as jest.Mock).mockClear();
  });

  it("filters exemptions in the query, audits only CAS-expired ids and requeues a failed asset delete", async () => {
    const orgRow = (id: string) => ({
      id,
      recordedAt: day("2020-01-01"),
      organizationId: "org-1",
      organization: { streamRecordingRetentionDays: 7 },
      meeting: {
        endedAt: day("2020-01-01"),
        occurrence: {
          endsAt: day("2020-01-01"),
          appointment: {
            consultationId: "c",
            webinarId: null,
            classId: null,
            subscription: null,
            trial: null,
            occurrences: [],
          },
        },
      },
    });
    mockOrgFindMany.mockResolvedValueOnce([
      { streamRecordingRetentionDays: 7 },
    ]);
    mockRecording.updateMany.mockResolvedValue({ count: 0 });
    mockRecording.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([orgRow("r1"), orgRow("r2")])
      .mockResolvedValueOnce([{ id: "x", storagePath: "p" }]);
    mockRecording.updateManyAndReturn.mockResolvedValue([{ id: "r1" }]);
    (deleteRecordingAssets as jest.Mock).mockResolvedValue({
      success: false,
      error: "boom",
    });

    const result = await expireRecordings();

    const scanWhere = mockRecording.findMany.mock.calls[1][0].where;
    expect(scanWhere).toMatchObject({
      listingStatus: { not: "PUBLISHED" },
      purchases: { none: { status: { in: ["PENDING", "SUCCEEDED"] } } },
    });
    const orgArm = scanWhere.OR.find(
      (arm: { organization?: unknown }) => arm.organization !== undefined,
    );
    expect(orgArm.recordedAt.lte.getTime()).toBeLessThanOrEqual(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    );
    // Webinar/class rows younger than 365 days are never due on the platform schedule.
    expect(scanWhere.OR).toContainEqual(
      expect.objectContaining({
        meeting: {
          occurrence: {
            appointment: { webinar: { is: null }, class: { is: null } },
          },
        },
      }),
    );
    expect(mockRecording.findMany.mock.calls[1][0].orderBy).toEqual([
      { recordedAt: "asc" },
      { id: "asc" },
    ]);
    expect(mockAuditCreate.mock.calls[0][0].data.details).toEqual({
      recordingIds: ["r1"],
      count: 1,
    });
    expect(mockRecording.updateMany).toHaveBeenLastCalledWith({
      where: { id: "x", status: "EXPIRED" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ expired: 1, failed: 1, success: false });
  });

  it("scans capped orgs from their own cap, inclusive, and skips classes with sessions still ahead", async () => {
    mockOrgFindMany.mockResolvedValueOnce([
      { streamRecordingRetentionDays: 30 },
    ]);
    mockRecording.updateMany.mockResolvedValue({ count: 0 });
    mockRecording.findMany.mockResolvedValue([]);

    await expireRecordings();

    const arms = mockRecording.findMany.mock.calls[1][0].where.OR as Array<
      Record<string, unknown>
    >;
    expect(arms).toHaveLength(3);
    expect(arms[0].meeting).toEqual({
      occurrence: {
        appointment: {
          OR: [
            { class: { is: null } },
            {
              occurrences: {
                none: expect.objectContaining({
                  deletedAt: null,
                  endsAt: { gt: expect.any(Date) },
                }),
              },
            },
          ],
        },
      },
    });
    expect(mockOrgFindMany.mock.calls[0][0].distinct).toEqual([
      "streamRecordingRetentionDays",
    ]);
    const capArm = arms[2] as {
      organization: unknown;
      recordedAt: { lte: Date };
    };
    expect(capArm.organization).toEqual({
      is: { streamRecordingRetentionDays: 30 },
    });
    const ageDays =
      (Date.now() - capArm.recordedAt.lte.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(ageDays)).toBe(30);
  });

  it("warns once when the scan cap is spent before the due limit is reached", async () => {
    const notDue = (id: string) => ({
      id,
      recordedAt: new Date(),
      organizationId: null,
      organization: null,
      meeting: {
        endedAt: new Date(),
        occurrence: {
          endsAt: new Date(),
          appointment: {
            consultationId: null,
            webinarId: "w",
            classId: null,
            subscription: null,
            trial: null,
            occurrences: [],
          },
        },
      },
    });
    mockRecording.updateMany.mockResolvedValue({ count: 0 });
    let page = 0;
    mockRecording.findMany.mockImplementation(
      async (args: { orderBy?: unknown }) => {
        if (!Array.isArray(args.orderBy)) return [];
        page += 1;
        return Array.from({ length: 200 }, (_, i) => notDue(`p${page}-${i}`));
      },
    );

    const result = await expireRecordings();

    expect(result.scanned).toBe(5_000);
    const scanCapWarnings = (
      reportSentryMessage as jest.Mock
    ).mock.calls.filter(([, ctx]) =>
      (ctx as { fingerprint: string[] }).fingerprint.includes("scan-cap"),
    );
    expect(scanCapWarnings).toHaveLength(1);
  });

  const lapsedRow = (id: string, filename = `${id}.mp4`) => ({
    id,
    streamCallId: `call-${id}`,
    streamRecordingId: filename,
  });
  const listed = (filename: string) => ({
    status: "listed" as const,
    recordings: [
      {
        filename,
        url: `https://us-east.stream-io-cdn.com/${filename}`,
        start_time: new Date(Date.now() - 3 * 3600_000),
        end_time: new Date(Date.now() - 2 * 3600_000),
        session_id: "sess",
      },
    ],
  });
  /** The lapsed-expiry write: the one updateMany that sets COPY_LAPSED. */
  const lapsedWrite = () =>
    mockRecording.updateMany.mock.calls
      .map(([args]) => args)
      .find((args) => args.data.removalReason === "COPY_LAPSED");

  it("refreshes a listed copy, and expires one whose filename Stream no longer lists", async () => {
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValueOnce(listed("live.mp4"))
      .mockResolvedValueOnce(listed("different-segment.mp4"));
    mockRecording.findMany.mockResolvedValueOnce([
      lapsedRow("live", "live.mp4"),
      lapsedRow("gone", "missing.mp4"),
    ]);

    await expireRecordings();

    expect(mockRecording.findMany.mock.calls[0][0].take).toBe(200);
    expect(mockRecording.updateMany).toHaveBeenCalledWith({
      where: { id: "live", status: "READY", storageType: "STREAM_S3" },
      data: expect.objectContaining({
        recordingUrl: "https://us-east.stream-io-cdn.com/live.mp4",
        streamUrlExpiresAt: expect.any(Date),
      }),
    });
    expect(lapsedWrite().where.OR).toContainEqual({ id: { in: ["gone"] } });
  });

  it("keeps a row READY when its listing fails, counts it, and reports once per run", async () => {
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValue({ status: "unavailable", error: "HTTP 429" });
    mockRecording.findMany.mockResolvedValueOnce([
      lapsedRow("a"),
      lapsedRow("b"),
      lapsedRow("c"),
    ]);

    const result = await expireRecordings();

    // Only the age and no-call-id arms remain: no failed row is named.
    expect(lapsedWrite().where.OR).toEqual([
      { recordedAt: { lt: expect.any(Date) } },
      { streamCallId: null },
    ]);
    expect(result).toMatchObject({ failed: 3, success: false });
    const failureReports = (reportSentryMessage as jest.Mock).mock.calls.filter(
      ([, ctx]) =>
        (ctx as { fingerprint: string[] }).fingerprint.includes("failures"),
    );
    expect(failureReports).toHaveLength(1);
    expect(failureReports[0][1].extra.recordingIds).toEqual(["a", "b", "c"]);
  });

  it("expires a lapsed row when Stream no longer knows the call (404)", async () => {
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValue({ status: "call-not-found" });
    mockRecording.findMany.mockResolvedValueOnce([lapsedRow("unknown-call")]);

    const result = await expireRecordings();

    expect(lapsedWrite().where.OR).toContainEqual({
      id: { in: ["unknown-call"] },
    });
    expect(result.failed).toBe(0);
  });

  it("asks Stream at most ten calls at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { status: "call-not-found" };
      });
    mockRecording.findMany.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => lapsedRow(`r${i}`)),
    );

    await expireRecordings();

    expect(peak).toBe(10);
  });

  it("deletes Stream's copy only for a size-verified R2 copy at least a day old, and marks it once", async () => {
    const transferred = {
      id: "t1",
      streamCallId: "call-t1",
      streamRecordingId: "t1.mp4",
      recordingUrl: "https://us-east.stream-io-cdn.com/t1.mp4",
    };
    mockRecording.findMany.mockImplementation(
      async (args: { where: { status?: string } }) =>
        args.where.status === "AVAILABLE" ? [transferred] : [],
    );
    mockRecording.updateMany.mockResolvedValue({ count: 1 });

    const first = await expireRecordings();

    const armWhere = mockRecording.findMany.mock.calls.find(
      ([args]) => args.where.status === "AVAILABLE",
    )[0].where;
    expect(armWhere).toMatchObject({
      storageType: "PLATFORM",
      storagePath: { not: null },
      streamRecordingId: { not: null },
      recordingUrl: { not: "" },
    });
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    expect(armWhere.transferredAt.lte.getTime()).toBeLessThanOrEqual(dayAgo);
    expect(mockDeleteCopy).toHaveBeenCalledWith(transferred);
    expect(mockRecording.updateMany).toHaveBeenCalledWith({
      where: {
        id: "t1",
        status: "AVAILABLE",
        recordingUrl: transferred.recordingUrl,
      },
      data: { recordingUrl: "" },
    });
    expect(first.streamCopiesDeleted).toBe(1);

    // A second run whose CAS finds the URL already cleared counts nothing.
    mockRecording.updateMany.mockResolvedValue({ count: 0 });
    const second = await expireRecordings();
    expect(second.streamCopiesDeleted).toBe(0);
  });

  it("keeps the Stream pointer and counts a failure when the vendor delete is unconfirmed", async () => {
    mockRecording.findMany.mockImplementation(
      async (args: { where: { status?: string } }) =>
        args.where.status === "AVAILABLE"
          ? [
              {
                id: "t2",
                streamCallId: "call-t2",
                streamRecordingId: "t2.mp4",
                recordingUrl: "u",
              },
            ]
          : [],
    );
    mockDeleteCopy.mockResolvedValue({ success: false, error: "HTTP 503" });

    const result = await expireRecordings();

    expect(mockRecording.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { recordingUrl: "" } }),
    );
    expect(result).toMatchObject({ streamCopiesDeleted: 0, failed: 1 });
  });
});
