/**
 * @jest-environment node
 */

/**
 * The broadcast audience: filters compose on the confirmed list, only a live
 * MARKETING_COMMS consent is mailable, a preview only counts, a test goes to the calling admin alone, a warm-up takes the most
 * recently confirmed N, and an audience above the limit is refused.
 */

const mockFindMany = jest.fn();
const mockArtifacts = jest.fn();
const mockBatchUpsert = jest.fn();
const mockBatchSend = jest.fn();
const mockFindSuppressed = jest.fn();
const mockHeld = jest.fn();
const mockOpsLog = jest.fn(
  async (_args: { data: Record<string, unknown> }) => ({ id: "ops_1" }),
);

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    newsletterSubscriber: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    consentArtifact: {
      findMany: (...args: unknown[]) => mockArtifacts(...args),
    },
    failedEmailBatch: {
      upsert: (...args: unknown[]) => mockBatchUpsert(...args),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: async () => ({ email: "Admin@Familiarise.test" }),
    },
    opsActionLog: {
      create: (args: { data: Record<string, unknown> }) => mockOpsLog(args),
    },
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN", email: "Admin@Familiarise.test" },
    },
  }),
}));
jest.mock("@/lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("@/lib/email", () => ({
  SENDERS: { newsletter: "Familiarise <news@familiarise.test>" },
  getResendClient: () => ({
    batch: {
      send: async (emails: unknown[]) => {
        mockBatchSend(emails);
        return { data: { data: emails }, error: null };
      },
    },
  }),
}));
jest.mock("@/lib/email/suppression", () => ({
  ...jest.requireActual("@/lib/email/suppression"),
  findSuppressed: (...args: unknown[]) => mockFindSuppressed(...args),
}));
jest.mock("@/lib/email/delivery-guard", () => ({
  heldRecipientDomain: (...args: unknown[]) => mockHeld(...args),
}));
jest.mock("@/lib/retry/provider-window", () => ({
  UNSETTLED: { in: ["PENDING", "RETRY"] },
  stampFirstAttempt: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/newsletter/broadcast/route";
import {
  BROADCAST_AUDIENCE_LIMIT,
  settledSendable,
} from "@/lib/newsletter/broadcast-audience";
import { audienceWhere } from "@/lib/newsletter/service";
import { broadcastSendBody } from "@/lib/backoffice/people-door-bodies";

const message = {
  subject: "Launch",
  htmlBody: "<p>Hello</p>",
  reason: "Launch announcement for the beta list",
};

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/newsletter/broadcast", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

/** Even rows are accounts, odd rows guests with a pseudonymous consent subject. */
function subscribers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    email: `s${i}@example.com`,
    userId: i % 2 === 0 ? `u${i}` : null,
    consentSubjectId: i % 2 === 0 ? null : `subj${i}`,
  }));
}

/** Every queried account and subject holds a live artifact, except those listed. */
function liveConsent(except: string[] = []) {
  mockArtifacts.mockImplementation(
    async (args: {
      where: {
        OR: [
          { userId: { in: string[] } },
          { subjectPseudonymousId: { in: string[] } },
        ];
      };
    }) =>
      [
        ...args.where.OR[0].userId.in.map((userId) => ({
          userId,
          subjectPseudonymousId: null,
        })),
        ...args.where.OR[1].subjectPseudonymousId.in.map((id) => ({
          userId: null,
          subjectPseudonymousId: id,
        })),
      ].filter(
        (a) => !except.includes(a.userId ?? a.subjectPseudonymousId ?? ""),
      ),
  );
}

const sentTo = () =>
  mockBatchSend.mock.calls.flatMap(([emails]: [Array<{ to: string }>]) =>
    emails.map((e) => e.to),
  );

describe("newsletter broadcast audience", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    mockBatchUpsert.mockResolvedValue({ id: "batch_1" });
    liveConsent();
    mockFindSuppressed.mockResolvedValue(new Set(["s1@example.com"]));
    mockHeld.mockImplementation((email: string) =>
      email === "s2@example.com" ? "example.com" : null,
    );
  });

  it("composes sources, tags and role on the confirmed list", () => {
    expect(
      audienceWhere({ sources: ["BLOG"], tags: ["beta"], role: "EXPERT" }),
    ).toEqual({
      status: "SUBSCRIBED",
      source: { in: ["BLOG"] },
      tags: { hasSome: ["beta"] },
      user: { is: { consultantProfile: { isNot: null } } },
    });
    expect(audienceWhere({ role: "NO_ACCOUNT" })).toEqual({
      status: "SUBSCRIBED",
      userId: null,
    });
    expect(audienceWhere({ role: "LEARNER" })).toMatchObject({
      user: { is: { consultantProfile: { is: null } } },
    });
  });

  it("previews the count after suppression and the pre-launch hold, sending nothing", async () => {
    mockFindMany.mockResolvedValue(subscribers(5));

    const res = await post({ mode: "preview", audience: { tags: ["beta"] } });

    expect(await res.json()).toMatchObject({
      matching: 5,
      sendable: 3,
      skippedSuppressed: 1,
      skippedHeld: 1,
    });
    expect(mockBatchSend).not.toHaveBeenCalled();
  });

  it("excludes and counts subscribers without a live MARKETING_COMMS artifact", async () => {
    mockFindMany.mockResolvedValue(subscribers(6));
    liveConsent(["u4", "subj5"]);

    const res = await post({ mode: "preview" });

    expect(await res.json()).toMatchObject({
      matching: 6,
      skippedNoConsent: 2,
      sendable: 2,
    });
    expect(mockArtifacts.mock.calls[0][0].where).toMatchObject({
      purposeCodes: { hasSome: expect.arrayContaining(["MARKETING_COMMS"]) },
      withdrawnAt: null,
    });
  });

  it("sends a test only to the calling admin", async () => {
    mockFindMany.mockResolvedValue(subscribers(5));

    const res = await post({ mode: "test", ...message });

    expect(res.status).toBe(200);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(sentTo()).toEqual(["admin@familiarise.test"]);
  });

  it("gives every test send its own batch key so a repeat test really sends", async () => {
    const keys = () =>
      mockBatchUpsert.mock.calls.map(([args]) => args.where.idempotencyKey);

    await post({ mode: "test", ...message });
    await post({ mode: "test", ...message });

    const [first, second] = keys();
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("warms up with the most recently confirmed sendable subscribers", async () => {
    mockFindMany.mockResolvedValue(subscribers(6));

    await post({ mode: "warmup", limit: 2, ...message });

    expect(mockFindMany.mock.calls[0][0].orderBy[0]).toEqual({
      confirmedAt: { sort: "desc", nulls: "last" },
    });
    expect(sentTo()).toEqual(["s0@example.com", "s3@example.com"]);
  });

  it("keeps earlier batch keys when a retried send gains a new confirmation", async () => {
    mockFindSuppressed.mockResolvedValue(new Set());
    mockHeld.mockReturnValue(null);
    const keys = () =>
      mockBatchUpsert.mock.calls.map(([args]) => args.where.idempotencyKey);

    mockFindMany.mockResolvedValue(subscribers(150));
    await post({ mode: "all", ...message });
    const first = keys();
    mockBatchUpsert.mockClear();
    mockFindMany.mockResolvedValue(subscribers(151));
    await post({ mode: "all", ...message });

    expect(mockFindMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(keys()[0]).toBe(first[0]);
  });

  it("refuses an audience above the limit with a 422", async () => {
    mockFindSuppressed.mockResolvedValue(new Set());
    mockHeld.mockReturnValue(null);
    mockFindMany.mockResolvedValue(subscribers(BROADCAST_AUDIENCE_LIMIT + 1));

    const res = await post({ mode: "all", ...message });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "AUDIENCE_TOO_LARGE" });
    expect(mockBatchSend).not.toHaveBeenCalled();
  });

  it("refuses a send without a reason before reading the audience", async () => {
    const { reason: _reason, ...noReason } = message;
    const res = await post({ mode: "all", ...noReason });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BODY" });
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockOpsLog).not.toHaveBeenCalled();
  });

  it("audits a send with the admin, the reason and what went out; a preview writes no row", async () => {
    mockFindMany.mockResolvedValue(subscribers(5));

    await post({ mode: "preview" });
    expect(mockOpsLog).not.toHaveBeenCalled();

    const res = await post({ mode: "all", ...message });
    expect(res.status).toBe(200);
    expect(mockOpsLog).toHaveBeenCalledTimes(1);
    expect(mockOpsLog.mock.calls[0]?.[0].data).toMatchObject({
      actorUserId: "admin_1",
      actorRole: "ADMIN",
      surface: "newsletter.send",
      action: "newsletter.broadcast",
      targetKind: "NewsletterMessage",
      reason: message.reason,
      before: { matching: 5, sendable: 3 },
      after: { status: "SUCCEEDED", mode: "all", sent: 3, subject: "Launch" },
    });
  });

  it.each(["test", "warmup", "all"] as const)(
    "accepts the %s body the newsletter screen builds",
    async (mode) => {
      mockFindMany.mockResolvedValue(subscribers(5));
      const res = await post(
        broadcastSendBody({
          mode,
          subject: message.subject,
          htmlBody: message.htmlBody,
          reason: message.reason,
          audience: { tags: ["beta"] },
          warmupLimit: 2,
        }),
      );
      expect(res.status).toBe(200);
    },
  );

  it("audits a refused send as FAILED with its code", async () => {
    mockFindMany.mockResolvedValue([]);

    const res = await post({ mode: "all", ...message });

    expect(res.status).toBe(404);
    expect(mockOpsLog.mock.calls[0]?.[0].data.after).toEqual({
      status: "FAILED",
      code: "NO_RECIPIENTS",
    });
  });
});

describe("settledSendable", () => {
  const settled = {
    data: { sendable: 7 },
    isPlaceholderData: false,
    isFetching: false,
    isError: false,
  };

  it("quotes only a settled, successful preview of the current filters", () => {
    expect(settledSendable(settled)).toBe(7);
    expect(settledSendable({ ...settled, isPlaceholderData: true })).toBeNull();
    expect(settledSendable({ ...settled, isFetching: true })).toBeNull();
    expect(settledSendable({ ...settled, isError: true })).toBeNull();
    expect(settledSendable({ ...settled, data: undefined })).toBeNull();
  });
});
