/** @jest-environment node */
const mockFind = jest.fn();
const mockCancel = jest.fn();
const mockUpsert = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      findFirst: (...args: unknown[]) => mockFind(...args),
      updateMany: (...args: unknown[]) => mockCancel(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
import prisma from "@/lib/prisma";
import {
  stageAnnouncementBell,
  cancelAnnouncementBells,
} from "@/lib/announcements/notifications";

const now = new Date("2026-11-05T00:00:00Z");
const announcement = {
  id: "one",
  title: "News",
  content: "Details",
  isActive: true,
  startDate: null,
  endDate: null,
  linkUrl: null,
  linkText: null,
  updatedAt: now,
};
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(now);
  jest.clearAllMocks();
  mockFind.mockResolvedValue(null);
  mockUpsert.mockImplementation(async ({ create }) => ({
    id: "row",
    ...create,
  }));
});
afterEach(() => jest.useRealTimers());

it("stages a scheduled broadcast with a delivery floor in the existing outbox", async () => {
  const startDate = new Date("2026-11-06T00:00:00Z");
  await stageAnnouncementBell(prisma, { ...announcement, startDate });
  expect(mockUpsert.mock.calls[0][0].create).toMatchObject({
    kind: "BROADCAST",
    notBefore: startDate,
    nextRetryAt: startDate,
    entityRef: "announcement:one",
    payload: { announcementId: "one", revision: now.toISOString() },
  });
});
it.each([{ isActive: false }, { endDate: now }])(
  "cancels unsent work for an inactive or expired source",
  async (patch) => {
    expect(
      await stageAnnouncementBell(prisma, { ...announcement, ...patch }),
    ).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCancel.mock.calls[0][0]).toMatchObject({
      where: {
        entityRef: "announcement:one",
        status: { in: ["PENDING", "RETRY"] },
      },
      data: { status: "DEAD_LETTER" },
    });
  },
);
it("replaces an unsent revision using distinct identity and cancels only the superseded rows", async () => {
  const previous = {
    ...announcement,
    startDate: new Date("2026-11-06T00:00:00Z"),
  };
  await stageAnnouncementBell(prisma, previous);
  const first = mockUpsert.mock.calls[0][0].create.transactionId;
  await stageAnnouncementBell(
    prisma,
    {
      ...previous,
      content: "Updated",
      updatedAt: new Date(now.getTime() + 1000),
    },
    previous,
  );
  const second = mockUpsert.mock.calls[1][0].create.transactionId;
  expect(second).not.toBe(first);
  expect(mockCancel.mock.calls[1][0].where.transactionId).toEqual({
    not: second,
  });
});
it("does not rebroadcast edits or reactivation when a sent row is recorded", async () => {
  mockFind.mockResolvedValue({ id: "sent" });
  expect(
    await stageAnnouncementBell(prisma, announcement, {
      isActive: false,
      startDate: null,
      endDate: null,
    }),
  ).toBeNull();
  expect(mockUpsert).not.toHaveBeenCalled();
});
it("does not create a new bell for an already-live edit with no queued publication", async () => {
  expect(
    await stageAnnouncementBell(prisma, announcement, announcement),
  ).toBeNull();
  expect(mockUpsert).not.toHaveBeenCalled();
});
it("publishes a newly activated draft", async () => {
  await stageAnnouncementBell(prisma, announcement, {
    isActive: false,
    startDate: null,
    endDate: null,
  });
  expect(mockUpsert).toHaveBeenCalledTimes(1);
});
it("cancels pending and retry rows without altering sent rows", async () => {
  await cancelAnnouncementBells(prisma, "one");
  expect(mockCancel).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["PENDING", "RETRY"] } }),
    }),
  );
});

it("can publish an expired unsent announcement when its window is extended", async () => {
  await stageAnnouncementBell(
    prisma,
    { ...announcement, endDate: new Date(now.getTime() + 60000) },
    { ...announcement, endDate: now },
  );
  expect(mockUpsert).toHaveBeenCalledTimes(1);
});
