/** @jest-environment node */
const mockQueryUsers = jest.fn();
const mockDeleteUsers = jest.fn(async (..._args: unknown[]) => ({}));
const mockPartialUpdateUsers = jest.fn(async (..._args: unknown[]) => ({}));
const mockFindMany = jest.fn(
  async (
    ..._args: unknown[]
  ): Promise<{ id: string; erasedAt: Date | null }[]> => [],
);
jest.mock("stream-chat", () => ({
  StreamChat: {
    getInstance: () => ({
      queryUsers: (...args: unknown[]) => mockQueryUsers(...args),
      deleteUsers: (...args: unknown[]) => mockDeleteUsers(...args),
      partialUpdateUsers: (...args: unknown[]) =>
        mockPartialUpdateUsers(...args),
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
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
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

describe("contact-field scrub", () => {
  const prismaUsers = (ids: string[]) =>
    mockFindMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, erasedAt: null })),
    );

  it("unsets a stored email on live users and leaves clean users alone", async () => {
    prismaUsers(["leaky", "clean"]);
    mockQueryUsers
      .mockResolvedValueOnce({
        users: [
          { id: "clean", name: "Clean" },
          { id: "leaky", name: "Leaky", email: "leaky@example.com" },
        ],
      })
      .mockResolvedValueOnce({ users: [] });

    const summary = await performStreamUserSync({ batchDelayMs: 0 });

    expect(mockPartialUpdateUsers).toHaveBeenCalledTimes(1);
    expect(mockPartialUpdateUsers).toHaveBeenCalledWith([
      { id: "leaky", unset: ["email"] },
    ]);
    expect(summary).toMatchObject({
      success: true,
      totalContactFieldsScrubbed: 1,
      totalFailedScrubs: 0,
    });
  });

  it("writes nothing when no user carries a contact field", async () => {
    prismaUsers(["clean"]);
    mockQueryUsers
      .mockResolvedValueOnce({ users: [{ id: "clean" }] })
      .mockResolvedValueOnce({ users: [] });

    await performStreamUserSync({ batchDelayMs: 0 });

    expect(mockPartialUpdateUsers).not.toHaveBeenCalled();
  });

  it("counts but does not write on a dry run", async () => {
    prismaUsers(["leaky"]);
    mockQueryUsers
      .mockResolvedValueOnce({
        users: [{ id: "leaky", email: "leaky@example.com" }],
      })
      .mockResolvedValueOnce({ users: [] });

    const summary = await performStreamUserSync({ dryRun: true });

    expect(mockPartialUpdateUsers).not.toHaveBeenCalled();
    expect(summary.totalContactFieldsScrubbed).toBe(1);
  });

  it("skips users already deleted in Stream or about to be hard-deleted", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "erased", erasedAt: new Date() },
    ]);
    mockQueryUsers
      .mockResolvedValueOnce({
        users: [
          { id: "erased", email: "erased@example.com" },
          {
            id: "gone",
            email: "gone@example.com",
            deleted_at: "2026-11-01T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({ users: [] });

    await performStreamUserSync({ batchDelayMs: 0 });

    expect(mockPartialUpdateUsers).not.toHaveBeenCalled();
  });

  it("holds the checkpoint before a page whose scrub failed and sends none of its deletions", async () => {
    jest.mocked(readJobCheckpoint).mockResolvedValue("before");
    mockFindMany.mockResolvedValueOnce([]);
    mockPartialUpdateUsers.mockRejectedValueOnce(new Error("rate limited"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockQueryUsers.mockResolvedValueOnce({
      users: [{ id: "orphan-leaky", email: "orphan@example.com" }],
    });

    const summary = await performStreamUserSync({ batchDelayMs: 0 });

    expect(summary).toMatchObject({
      checkpoint: "before",
      hasMore: true,
      totalFailedScrubs: 1,
    });
    expect(mockQueryUsers).toHaveBeenCalledTimes(1);
    expect(mockDeleteUsers).not.toHaveBeenCalled();
  });

  it("reports a failed scrub once in the summary instead of throwing", async () => {
    prismaUsers(["leaky"]);
    mockPartialUpdateUsers.mockRejectedValueOnce(new Error("rate limited"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockQueryUsers
      .mockResolvedValueOnce({
        users: [{ id: "leaky", email: "leaky@example.com" }],
      })
      .mockResolvedValueOnce({ users: [] });

    const summary = await performStreamUserSync({ batchDelayMs: 0 });

    expect(summary).toMatchObject({
      success: false,
      totalContactFieldsScrubbed: 0,
      totalFailedScrubs: 1,
    });
  });
});
