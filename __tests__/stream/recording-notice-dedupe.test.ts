/**
 * @jest-environment node
 */

const claims = new Set<string>();
const mockStagePrepared = jest.fn();

jest.mock("../../lib/prisma", () => {
  const idempotencyRecord = {
    findMany: jest.fn(
      async ({ where }: { where: { scope: string; key: { in: string[] } } }) =>
        where.key.in
          .filter((key) => claims.has(`${where.scope}|${key}`))
          .map((key) => ({ userId: key.split(":").pop() })),
    ),
    createManyAndReturn: jest.fn(
      async ({
        data,
      }: {
        data: { scope: string; key: string; userId: string }[];
      }) =>
        data.flatMap((row) => {
          const id = `${row.scope}|${row.key}`;
          if (claims.has(id)) return [];
          claims.add(id);
          return [{ userId: row.userId }];
        }),
    ),
  };
  const client = {
    idempotencyRecord,
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { __esModule: true, default: client };
});

jest.mock("../../lib/email/preferences", () => ({
  loadEmailRecipients: async (userIds: string[]) =>
    userIds.map((userId) => ({
      userId,
      email: `${userId}@example.test`,
      name: userId,
      zone: "Asia/Kolkata",
      allowed: true,
      unsubscribeUrl: null,
    })),
}));

jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
  prepareRecipientEmails: async (args: {
    recipients: { email: string }[];
    emailType: string;
    entityRef: string;
  }) => ({
    emailType: args.emailType,
    entityRef: args.entityRef,
    messages: args.recipients.map((r) => ({ to: r.email })),
    skipped: 0,
    failed: 0,
  }),
  stagePreparedEmails: (...args: unknown[]) => mockStagePrepared(...args),
  sendToRecipients: jest.fn(),
  stageToRecipients: jest.fn(),
}));

import { stageDocumentAndRecordingEmailOnce } from "../../lib/email/senders/booking";

const readyClaim = (recordingId: string) => ({
  scope: "stream.recording-ready",
  key: (userId: string) => `recording-ready:${recordingId}:${userId}`,
  ttlMs: 60_000,
});

const args = (userIds: string[]) => ({
  entityId: "rec-1",
  userIds,
  kind: "RECORDING_READY" as const,
  dashboardUrl: "/dashboard/recordings",
});

describe("stageDocumentAndRecordingEmailOnce", () => {
  beforeEach(() => {
    claims.clear();
    mockStagePrepared
      .mockReset()
      .mockImplementation(
        async (_tx: unknown, prepared: { messages: { to: string }[] }) =>
          prepared.messages.map((message) => ({
            staged: { id: `fe-${message.to}` },
            message,
          })),
      );
  });

  it("stages one email per recipient across duplicate ready deliveries", async () => {
    const first = await stageDocumentAndRecordingEmailOnce(
      args(["u1", "u2"]),
      readyClaim("rec-1"),
    );
    const second = await stageDocumentAndRecordingEmailOnce(
      args(["u1", "u2", "u3"]),
      readyClaim("rec-1"),
    );

    expect(first.map((e) => e.message.to)).toEqual([
      "u1@example.test",
      "u2@example.test",
    ]);
    expect(second.map((e) => e.message.to)).toEqual(["u3@example.test"]);
    expect(mockStagePrepared).toHaveBeenCalledTimes(3);
  });

  it("stages nothing for a recipient whose claim a concurrent run won", async () => {
    const prisma = jest.requireMock("../../lib/prisma").default;
    prisma.idempotencyRecord.findMany.mockResolvedValueOnce([]);
    claims.add("stream.recording-ready|recording-ready:rec-1:u1");

    const staged = await stageDocumentAndRecordingEmailOnce(
      args(["u1"]),
      readyClaim("rec-1"),
    );

    expect(staged).toEqual([]);
    expect(mockStagePrepared).not.toHaveBeenCalled();
  });
});
