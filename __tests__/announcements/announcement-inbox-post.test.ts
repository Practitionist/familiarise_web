/**
 * @jest-environment node
 */

/**
 * Creating an announcement posts to inboxes only when asked. The post fans
 * out server-side through bell policy as MULTI outbox rows of at most 100
 * recipients, staged in the create transaction under stable per-page keys.
 */

const mockFindMany = jest.fn();
const mockCreate = jest.fn();
const mockCreateManyAndReturn = jest.fn();
const mockFlush = jest.fn();
const mockTransaction = jest.fn();
const mockGetSession = jest.fn();
const tx = {
  user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  announcement: { create: (...args: unknown[]) => mockCreate(...args) },
  notificationOutbox: {
    createManyAndReturn: (...args: unknown[]) =>
      mockCreateManyAndReturn(...args),
  },
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>, opts: unknown) => {
      mockTransaction(opts);
      return fn(tx);
    },
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));
jest.mock("next/cache", () => ({
  revalidateTag: jest.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/announcements/route";
import { GET as getAudience } from "@/app/api/announcements/audience/route";
import { deriveTransactionId } from "@/lib/novu/outbox";
import { MAX_BELL_AUDIENCE } from "@/lib/novu/policy";

type OutboxRow = {
  kind: string;
  recipients: string[];
  transactionId: string;
  entityRef: string;
  workflowId: string;
};

function user(id: string, prefs: Record<string, boolean> | null = null) {
  return { id, erasedAt: null, notificationPreferences: prefs };
}

function createRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/announcements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Diwali hours", content: "Closed", ...body }),
  });
}

function stagedRows(): OutboxRow[] {
  return mockCreateManyAndReturn.mock.calls.flatMap(
    ([args]: [{ data: OutboxRow[] }]) => args.data,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockImplementation(async ({ data }) => ({ id: "ann1", ...data }));
  mockCreateManyAndReturn.mockImplementation(
    async ({ data }: { data: OutboxRow[] }) =>
      data.map((row, i) => ({ id: `row${i}`, ...row })),
  );
  mockFlush.mockResolvedValue(undefined);
  mockGetSession.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } });
});

describe("POST /api/announcements", () => {
  it("stages nothing and reads no users without postToInbox", async () => {
    const res = await POST(createRequest({}));

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCreateManyAndReturn).not.toHaveBeenCalled();
    expect(
      mockFlush.mock.calls.flatMap(([bundle]) => bundle.bells ?? []),
    ).toEqual([]);
  });

  it("fans out to policy-allowed users in MULTI pages of at most 100", async () => {
    const allowed = Array.from({ length: 250 }, (_, i) =>
      user(`u${String(i).padStart(3, "0")}`),
    );
    mockFindMany.mockResolvedValue([
      ...allowed,
      user("v-inapp-off", { allNotifications: true, inAppEnabled: false }),
      user("v-paused", { allNotifications: false, inAppEnabled: true }),
    ]);

    const res = await POST(createRequest({ postToInbox: true }));

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailVerified: true,
          banned: false,
          erasedAt: null,
        }),
        orderBy: { id: "asc" },
      }),
    );
    const rows = stagedRows();
    expect(rows.map((r) => r.recipients.length)).toEqual([100, 100, 50]);
    expect(rows.every((r) => r.kind === "MULTI")).toBe(true);
    expect(rows.every((r) => r.entityRef === "announcement:ann1")).toBe(true);
    expect(rows.every((r) => r.workflowId === "general-announcement")).toBe(
      true,
    );
    const everyone = rows.flatMap((r) => r.recipients);
    expect(everyone).toEqual(allowed.map((u) => u.id));
    expect(everyone.some((id) => id.startsWith("v-"))).toBe(false);

    // Page n is keyed `announcement:<id>:page:<n>`, so its id is stable.
    rows.forEach((row, i) => {
      expect(row.transactionId).toBe(
        deriveTransactionId(
          "general-announcement",
          row.recipients,
          { title: "Diwali hours", content: "Closed" },
          `announcement:ann1:page:${i + 1}`,
        ),
      );
    });
    expect(mockCreateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    // Only the first pages are attempted inline; the relay sends the rest.
    const [[{ bells }]] = mockFlush.mock.calls;
    expect(bells).toHaveLength(3);
    // The fan-out transaction runs under an explicit, bounded timeout.
    expect(mockTransaction).toHaveBeenCalledWith({
      timeout: 15_000,
      maxWait: 5_000,
    });
  });

  it("refuses an inbox post for an inactive or scheduled announcement", async () => {
    const inactive = await POST(
      createRequest({ postToInbox: true, isActive: false }),
    );
    const scheduled = await POST(
      createRequest({
        postToInbox: true,
        startDate: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );

    expect(inactive.status).toBe(400);
    expect(scheduled.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCreateManyAndReturn).not.toHaveBeenCalled();
  });

  it("refuses, without creating, when the audience is over the cap", async () => {
    mockFindMany.mockResolvedValue(
      Array.from({ length: MAX_BELL_AUDIENCE + 1 }, (_, i) => user(`u${i}`)),
    );

    const res = await POST(createRequest({ postToInbox: true }));

    expect(res.status).toBe(422);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCreateManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("GET /api/announcements/audience", () => {
  it("counts the users an inbox post would ring, through the same policy", async () => {
    mockFindMany.mockResolvedValue([
      user("u1"),
      user("u2"),
      user("v-inapp-off", { allNotifications: true, inAppEnabled: false }),
    ]);

    const res = await getAudience();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      data: { eligible: 2, cap: MAX_BELL_AUDIENCE },
    });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_BELL_AUDIENCE + 1 }),
    );
  });

  it("reports an audience over the cap as null", async () => {
    mockFindMany.mockResolvedValue(
      Array.from({ length: MAX_BELL_AUDIENCE + 1 }, (_, i) => user(`u${i}`)),
    );

    const res = await getAudience();

    await expect(res.json()).resolves.toMatchObject({
      data: { eligible: null },
    });
  });

  it("needs the same permission as creating an announcement", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "s1", role: "STAFF" } });

    const res = await getAudience();

    expect(res.status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
