/**
 * @jest-environment node
 */

const mockRecording = {
  updateMany: jest.fn(),
  findMany: jest.fn(),
  updateManyAndReturn: jest.fn(),
};
const mockAuditCreate = jest.fn();
jest.mock("../../lib/prisma", () => {
  const client = {
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

import { deleteRecordingAssets } from "../../lib/stream/recording-storage";
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

  it("keeps subscription and trial recordings until 90 days after the subscription ends", () => {
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
            consultation: { id: "c" },
            webinar: null,
            class: null,
            subscription: null,
            trial: null,
            occurrences: [],
          },
        },
      },
    });
    mockRecording.updateMany.mockResolvedValue({ count: 0 });
    mockRecording.findMany
      .mockResolvedValueOnce([orgRow("r1"), orgRow("r2")])
      .mockResolvedValueOnce([{ id: "x", storagePath: "p" }]);
    mockRecording.updateManyAndReturn.mockResolvedValue([{ id: "r1" }]);
    (deleteRecordingAssets as jest.Mock).mockResolvedValue({
      success: false,
      error: "boom",
    });

    const result = await expireRecordings();

    const scanWhere = mockRecording.findMany.mock.calls[0][0].where;
    expect(scanWhere).toMatchObject({
      listingStatus: { not: "PUBLISHED" },
      purchases: { none: { status: { in: ["PENDING", "SUCCEEDED"] } } },
    });
    const orgArm = scanWhere.OR.find(
      (arm: { organization?: unknown }) => arm.organization !== undefined,
    );
    expect(orgArm.recordedAt.lt.getTime()).toBeLessThanOrEqual(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    );
    // Webinar/class rows on the platform schedule younger than 365 days can never be due, so they stay out of the scan window.
    expect(scanWhere.OR).toContainEqual(
      expect.objectContaining({
        OR: [
          { organizationId: null },
          { organization: { is: { streamRecordingRetentionDays: null } } },
        ],
        meeting: {
          occurrence: {
            appointment: { webinar: { is: null }, class: { is: null } },
          },
        },
      }),
    );
    expect(mockRecording.findMany.mock.calls[0][0].orderBy).toEqual([
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

  it("scans org rows on the 7-day floor only when the org set a cap", async () => {
    mockRecording.updateMany.mockResolvedValue({ count: 0 });
    mockRecording.findMany.mockResolvedValue([]);

    await expireRecordings();

    const arms = mockRecording.findMany.mock.calls[0][0].where.OR as Array<
      Record<string, unknown>
    >;
    expect(arms).toHaveLength(3);
    // No arm admits every org row: an uncapped org follows the platform arms.
    for (const arm of arms) {
      expect(arm.organizationId).not.toEqual({ not: null });
    }
    expect(arms[2]).toEqual(
      expect.objectContaining({
        organization: { is: { streamRecordingRetentionDays: { not: null } } },
      }),
    );
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
            consultation: null,
            webinar: { id: "w" },
            class: null,
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
});
