/**
 * @jest-environment node
 */

/**
 * Maintenance notices fan out server-side through bell policy, like inbox
 * posts: MULTI outbox rows of at most 100 recipients, staged in the caller's
 * transaction under stable per-page keys, once per window and event under an
 * advisory lock. Over the audience cap nothing is staged.
 */

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { stageMaintenanceBells } from "@/lib/novu/service";
import { bellAudience, MAX_BELL_AUDIENCE } from "@/lib/novu/policy";
import { deriveTransactionId } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

type OutboxRow = {
  workflowId: string;
  kind: string;
  recipients: string[];
  transactionId: string;
  entityRef: string;
  payload: Record<string, unknown>;
};

const findMany = jest.fn();
const createManyAndReturn = jest.fn();
const executeRaw = jest.fn();
/** The outbox rows staged so far, which the existence check reads. */
let store: OutboxRow[] = [];
const tx = {
  $executeRaw: (...args: unknown[]) => executeRaw(...args),
  user: { findMany: (...args: unknown[]) => findMany(...args) },
  notificationOutbox: {
    createManyAndReturn: (...args: unknown[]) => createManyAndReturn(...args),
    findFirst: async (args: {
      where: { entityRef: string; workflowId: string };
    }) =>
      store.find(
        (r) =>
          r.entityRef === args.where.entityRef &&
          r.workflowId === args.where.workflowId,
      ) ?? null,
  },
} as unknown as Parameters<typeof stageMaintenanceBells>[0];

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

const stagedRows = (): OutboxRow[] =>
  createManyAndReturn.mock.calls.flatMap(
    ([args]: [{ data: OutboxRow[] }]) => args.data,
  );

beforeEach(() => {
  jest.clearAllMocks();
  store = [];
  createManyAndReturn.mockImplementation(
    async ({ data }: { data: OutboxRow[] }) => {
      store.push(...data);
      return data;
    },
  );
});

it("stages policy-filtered pages under stable maintenance keys", async () => {
  const allowed = Array.from({ length: 150 }, (_, i) => user(`u${i}`));
  findMany.mockResolvedValue([
    ...allowed,
    user("muted", { allNotifications: true, inAppEnabled: false }),
    user("email-only", null, "EMAIL_ONLY"),
  ]);

  const staged = await stageMaintenanceBells(
    tx,
    NOVU_WORKFLOWS.MAINTENANCE_ENDED,
    { phase: "OFF", reason: "Maintenance completed" },
    "win1",
  );

  expect(staged).toHaveLength(2);
  const rows = stagedRows();
  expect(rows.map((r) => r.recipients.length)).toEqual([100, 50]);
  expect(rows.flatMap((r) => r.recipients)).not.toContain("muted");
  expect(rows.flatMap((r) => r.recipients)).not.toContain("email-only");
  expect(rows[0]).toMatchObject({
    kind: "MULTI",
    entityRef: "maintenance:win1",
    payload: expect.objectContaining({ reason: "Maintenance completed" }),
    transactionId: deriveTransactionId(
      NOVU_WORKFLOWS.MAINTENANCE_ENDED,
      rows[0].recipients,
      rows[0].payload as Record<string, string>,
      "maintenance:win1:page:1",
    ),
  });
  expect(createManyAndReturn.mock.calls[0][0]).toMatchObject({
    skipDuplicates: true,
  });
});

it("stages nothing over the audience cap", async () => {
  findMany.mockResolvedValue(
    Array.from({ length: MAX_BELL_AUDIENCE + 1 }, (_, i) => user(`u${i}`)),
  );

  await expect(
    stageMaintenanceBells(
      tx,
      NOVU_WORKFLOWS.MAINTENANCE_SCHEDULED,
      { phase: "DEGRADED" },
      "win2",
    ),
  ).resolves.toBeNull();
  expect(findMany.mock.calls[0][0]).toMatchObject({
    take: MAX_BELL_AUDIENCE + 1,
  });
  expect(createManyAndReturn).not.toHaveBeenCalled();
});

it("counts only users bell policy allows against the cap", async () => {
  findMany.mockResolvedValue([user("u1")]);

  await stageMaintenanceBells(
    tx,
    NOVU_WORKFLOWS.MAINTENANCE_SCHEDULED,
    { phase: "DEGRADED" },
    "win-cap",
  );

  // Muted and email-only users must not use up the cap in the query itself.
  expect(findMany.mock.calls[0][0].where).toMatchObject({
    emailVerified: true,
    banned: false,
    erasedAt: null,
    AND: [
      {
        OR: [
          { orgWorkspaceProfile: { is: null } },
          {
            orgWorkspaceProfile: {
              is: {
                notificationRoutingMode: { notIn: ["EMAIL_ONLY", "NEITHER"] },
              },
            },
          },
        ],
      },
      {
        OR: [
          { notificationPreferences: { is: null } },
          {
            notificationPreferences: {
              is: { allNotifications: true, inAppEnabled: true },
            },
          },
        ],
      },
    ],
  });
});

it("also filters on the workflow's preference category", async () => {
  findMany.mockResolvedValue([]);

  await bellAudience(tx, NOVU_WORKFLOWS.PAYMENT_SUCCESS, MAX_BELL_AUDIENCE);

  expect(findMany.mock.calls[0][0].where.AND[1].OR[1]).toEqual({
    notificationPreferences: {
      is: {
        allNotifications: true,
        inAppEnabled: true,
        paymentNotifications: true,
      },
    },
  });
});

it("stages a window's notice once, even when a retry sees a larger audience", async () => {
  findMany.mockResolvedValueOnce([user("u1"), user("u2")]);
  const first = await stageMaintenanceBells(
    tx,
    NOVU_WORKFLOWS.MAINTENANCE_STARTED,
    { phase: "OFFLINE" },
    "win3",
  );
  findMany.mockResolvedValueOnce([user("u1"), user("u2"), user("u3")]);
  const retry = await stageMaintenanceBells(
    tx,
    NOVU_WORKFLOWS.MAINTENANCE_STARTED,
    { phase: "OFFLINE" },
    "win3",
  );

  expect(first).toHaveLength(1);
  expect(retry).toEqual([]);
  expect(stagedRows()).toHaveLength(1);
  // Both calls serialise on the same window/event lock before reading.
  expect(executeRaw).toHaveBeenCalledTimes(2);
  expect(executeRaw.mock.calls[0].slice(1)).toEqual([
    `maintenance:win3:${NOVU_WORKFLOWS.MAINTENANCE_STARTED}`,
  ]);
  expect(executeRaw.mock.calls[1].slice(1)).toEqual(
    executeRaw.mock.calls[0].slice(1),
  );
});

it("still stages a different event for the same window", async () => {
  findMany.mockResolvedValue([user("u1")]);
  await stageMaintenanceBells(
    tx,
    NOVU_WORKFLOWS.MAINTENANCE_STARTED,
    { phase: "OFFLINE" },
    "win4",
  );
  await stageMaintenanceBells(
    tx,
    NOVU_WORKFLOWS.MAINTENANCE_ENDED,
    { phase: "OFF" },
    "win4",
  );

  expect(stagedRows().map((r) => r.workflowId)).toEqual([
    NOVU_WORKFLOWS.MAINTENANCE_STARTED,
    NOVU_WORKFLOWS.MAINTENANCE_ENDED,
  ]);
});
