/** @jest-environment node */
/** A room whose Stream call does not exist has nothing to block; a genuine failure is recorded on the intent. */

const notFound = () =>
  Object.assign(new Error("call not found"), { status: 404 });
const mockCall = {
  kickUser: jest.fn(async (_req: unknown): Promise<unknown> => {
    throw notFound();
  }),
  blockUser: jest.fn(async (_req: unknown): Promise<unknown> => {
    throw notFound();
  }),
  unblockUser: jest.fn(async () => ({})),
};
const mockRetry = {
  findFirst: jest.fn(async () => null),
  updateMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
  createMany: jest.fn(async () => ({ count: 1 })),
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: jest.fn(async () => [{ id: "m-1", streamCallId: "call-1" }]),
    },
    get streamRevocationRetry() {
      return mockRetry;
    },
  },
}));
jest.mock("@/lib/stream-client", () => ({
  ...jest.requireActual("@/lib/stream-client"),
  isStreamConfigured: () => true,
  getStreamVideoClient: () => ({ video: { call: () => mockCall } }),
}));
jest.mock("@/lib/support/conduct-removal-state", () => ({
  conductRemovalStands: jest.fn(async () => true),
}));

import { driveConductCallBlock } from "@/lib/stream/conduct-call-block";
import { syncConductCallBlock } from "@/lib/stream/access-revocation";

beforeEach(() => jest.clearAllMocks());

it("settles a room whose Stream call does not exist", async () => {
  await expect(
    driveConductCallBlock(
      "appt-1",
      "u-1",
      Date.now() + 5_000,
      async () => undefined,
    ),
  ).resolves.toBeNull();
});

it("records the attempt and the error on the intent when a block genuinely fails", async () => {
  mockCall.kickUser.mockRejectedValueOnce(
    Object.assign(new Error("Stream is down"), { status: 500 }),
  );
  const generation = new Date();
  await syncConductCallBlock("appt-1", "u-1", generation);
  expect(mockRetry.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        kind: "CONDUCT_CALL_BLOCK",
        nextRetryAt: generation,
      }),
      data: expect.objectContaining({
        status: "FAILED",
        attempts: { increment: 1 },
        lastError: "call block failed",
      }),
    }),
  );
});
