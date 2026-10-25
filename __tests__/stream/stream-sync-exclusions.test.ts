/** @jest-environment node */
const mockQueryUsers = jest.fn();
const mockDeleteUsers = jest.fn(async (..._args: unknown[]) => ({}));
jest.mock("stream-chat", () => ({
  StreamChat: {
    getInstance: () => ({
      queryUsers: (...args: unknown[]) => mockQueryUsers(...args),
      deleteUsers: (...args: unknown[]) => mockDeleteUsers(...args),
    }),
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  readJobCheckpoint: jest.fn().mockResolvedValue(null),
  withCronLock: jest.fn(
    async (_job: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { user: { findMany: jest.fn(async () => []) } },
}));

import { readJobCheckpoint } from "../../lib/cron/with-cron-lock";
import { SUPPORT_STREAM_USER_ID } from "../../lib/stream/support-user";
import { performStreamUserSync } from "../../scripts/stream/stream-sync";

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readJobCheckpoint).mockResolvedValue(null);
});

beforeAll(() => {
  process.env.STREAM_API_KEY = "key";
  process.env.STREAM_API_SECRET = "secret";
  jest.spyOn(console, "log").mockImplementation(() => {});
});

it("never deletes the Familiarise Support Stream user, which has no DB row", async () => {
  mockQueryUsers
    .mockResolvedValueOnce({
      users: [{ id: SUPPORT_STREAM_USER_ID }, { id: "gone-user" }],
    })
    .mockResolvedValueOnce({ users: [] });

  const summary = await performStreamUserSync({ batchDelayMs: 0 });

  expect(summary.totalStaleUsersIdentified).toBe(1);
  expect(mockDeleteUsers).toHaveBeenCalledTimes(1);
  expect(mockDeleteUsers).toHaveBeenCalledWith(["gone-user"], {
    user: "soft",
    messages: "soft",
  });
});

it("bounds a principal scan to five pages and resumes the remaining tail", async () => {
  const users = Array.from({ length: 601 }, (_, i) => ({
    id: `system-u${String(i).padStart(3, "0")}`,
  }));
  mockQueryUsers.mockImplementation(async (filter, _sort, opts) => ({
    users: users
      .filter((user) => !filter.id || user.id > filter.id.$gt)
      .slice(0, opts.limit),
  }));
  const first = await performStreamUserSync();
  expect(first).toMatchObject({
    totalStreamUsersProcessed: 500,
    checkpoint: "system-u499",
    hasMore: true,
  });
  expect(mockQueryUsers).toHaveBeenCalledTimes(5);
  jest.mocked(readJobCheckpoint).mockResolvedValue(first.checkpoint);
  const second = await performStreamUserSync();
  expect(second).toMatchObject({
    totalStreamUsersProcessed: 101,
    checkpoint: null,
    hasMore: false,
  });
  expect(mockDeleteUsers).not.toHaveBeenCalled();
});
it("dry-run comparison preserves its starting checkpoint and issues no deletion request", async () => {
  jest.mocked(readJobCheckpoint).mockResolvedValue("previous");
  mockQueryUsers
    .mockResolvedValueOnce({ users: [{ id: "stale-user" }] })
    .mockResolvedValueOnce({ users: [] });
  expect(await performStreamUserSync({ dryRun: true })).toMatchObject({
    totalStaleUsersIdentified: 1,
    checkpoint: "previous",
    deletionTaskIds: [],
  });
  expect(mockDeleteUsers).not.toHaveBeenCalled();
});
