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

import { SUPPORT_STREAM_USER_ID } from "../../lib/stream/support-user";
import { performStreamUserSync } from "../../scripts/stream/stream-sync";

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
