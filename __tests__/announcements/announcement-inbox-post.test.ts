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
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "admin1", role: "ADMIN" } })),
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
import { deriveTransactionId } from "@/lib/novu/outbox";

type OutboxRow = {
  kind: string;
  recipients: string[];
  transactionId: string;
  entityRef: string;
  workflowId: string;
};

function user(
  id: string,
  prefs: Record<string, boolean> | null = null,
  routing: string | null = null,
) {
  return {
    id,
    erasedAt: null,
    orgWorkspaceProfile: routing ? { notificationRoutingMode: routing } : null,
    notificationPreferences: prefs,
  };
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
      user("v-email-only", null, "EMAIL_ONLY"),
      user("v-neither", null, "NEITHER"),
    ]);

    const res = await POST(createRequest({ postToInbox: true }));

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailVerified: true, banned: false, erasedAt: null },
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
      Array.from({ length: 10_001 }, (_, i) => user(`u${i}`)),
    );

    const res = await POST(createRequest({ postToInbox: true }));

    expect(res.status).toBe(422);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCreateManyAndReturn).not.toHaveBeenCalled();
  });
});
