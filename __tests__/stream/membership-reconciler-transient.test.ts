/**
 * @jest-environment node
 */

const mockReport = jest.fn();
const mockReadCheckpoint = jest.fn();
const mockQueryChannels = jest.fn();

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/auth-helpers", () => ({ isPrivileged: () => false }));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({ queryChannels: mockQueryChannels }),
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: () => false,
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
  readJobCheckpoint: (...args: unknown[]) => mockReadCheckpoint(...args),
  isDbConnectionOrPoolError: (e: unknown) =>
    e instanceof Error && /timeout/i.test(e.message),
}));

import { reconcileStreamMemberships } from "../../lib/stream/membership-reconciler";

beforeEach(() => jest.clearAllMocks());

describe("reconcileStreamMemberships checkpoint read", () => {
  it("returns a retry-next-tick result on a transient Postgres timeout", async () => {
    mockReadCheckpoint.mockRejectedValue(new Error("Query read timeout"));

    const result = await reconcileStreamMemberships({ limit: 5 });

    expect(result.success).toBe(true);
    expect(result.channelsScanned).toBe(0);
    expect("checkpoint" in result).toBe(false);
    expect(mockQueryChannels).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport.mock.calls[0][1]).toMatchObject({ level: "warning" });
  });

  it("rethrows a non-transient checkpoint failure", async () => {
    mockReadCheckpoint.mockRejectedValue(new Error("column does not exist"));

    await expect(reconcileStreamMemberships({ limit: 5 })).rejects.toThrow(
      "column does not exist",
    );
  });
});
