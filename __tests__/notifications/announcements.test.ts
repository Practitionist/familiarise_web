/** @jest-environment node */
const mockCreate = jest.fn();
const mockFind = jest.fn();
const mockList = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockStage = jest.fn();
const mockCancel = jest.fn();
const mockFlush = jest.fn();
const mockSession = jest.fn();
const mockTx = {
  announcement: {
    create: mockCreate,
    findUnique: mockFind,
    update: mockUpdate,
    deleteMany: mockDelete,
  },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    announcement: { findMany: (...args: unknown[]) => mockList(...args) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  },
}));
jest.mock("../../lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("../../lib/announcements/notifications", () => ({
  stageAnnouncementBell: (...args: unknown[]) => mockStage(...args),
  cancelAnnouncementBells: (...args: unknown[]) => mockCancel(...args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
}));
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/announcements/route";
import { PATCH, DELETE } from "@/app/api/announcements/[id]/route";

const announcement = {
  id: "announcement-one",
  title: "News",
  content: "Details",
  isActive: true,
  startDate: null,
  endDate: null,
  updatedAt: new Date("2026-11-05T00:00:00Z"),
};
const params = { params: Promise.resolve({ id: announcement.id }) };
function request(method: string, body?: unknown, query = "") {
  return new NextRequest(`https://app.test/api/announcements${query}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockResolvedValue({ user: { id: "admin", role: "ADMIN" } });
  mockCreate.mockResolvedValue(announcement);
  mockFind.mockResolvedValue(announcement);
  mockUpdate.mockResolvedValue(announcement);
  mockDelete.mockResolvedValue({ count: 1 });
  mockStage.mockResolvedValue({ id: "bell" });
  mockList.mockResolvedValue([announcement]);
});

it("keeps public listing date-filtered and independent of session reads", async () => {
  const response = await GET(request("GET"));
  expect(response.status).toBe(200);
  expect(mockSession).not.toHaveBeenCalled();
  expect(mockList).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ isActive: true }),
      take: 5,
    }),
  );
});
it("lists inactive and scheduled announcements only in authenticated management mode", async () => {
  const response = await GET(request("GET", undefined, "?view=manage"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(mockList).toHaveBeenCalledWith({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
});
it.each([null, { user: { id: "staff", role: "STAFF" } }])(
  "refuses management listing without the required role",
  async (session) => {
    mockSession.mockResolvedValue(session);
    expect((await GET(request("GET", undefined, "?view=manage"))).status).toBe(
      session ? 403 : 401,
    );
    expect(mockList).not.toHaveBeenCalled();
  },
);
it("stages the announcement inside its creation transaction", async () => {
  expect(
    (
      await POST(
        request("POST", { title: "News", content: "Details", linkUrl: null }),
      )
    ).status,
  ).toBe(200);
  expect(mockStage).toHaveBeenCalledWith(mockTx, announcement);
  expect(mockFlush).toHaveBeenCalledWith(
    { bells: [{ id: "bell" }] },
    "announcements.create",
  );
});
it("rejects invalid date windows and unsafe link protocols before creating", async () => {
  for (const patch of [
    { startDate: "2027-02-01T00:00:00Z", endDate: "2027-01-01T00:00:00Z" },
    { linkUrl: "javascript:alert(1)" },
  ]) {
    expect(
      (
        await POST(
          request("POST", { title: "News", content: "Details", ...patch }),
        )
      ).status,
    ).toBe(400);
  }
  expect(mockCreate).not.toHaveBeenCalled();
});
it("does not report success when transactional staging fails", async () => {
  mockStage.mockRejectedValueOnce(new Error("outbox write failed"));
  expect(
    (await POST(request("POST", { title: "News", content: "Details" }))).status,
  ).toBe(500);
  expect(mockFlush).not.toHaveBeenCalled();
});
it("validates a partial edit against the stored date window", async () => {
  mockFind.mockResolvedValue({
    ...announcement,
    startDate: new Date("2027-02-01T00:00:00Z"),
  });
  expect(
    (await PATCH(request("PATCH", { endDate: "2027-01-01T00:00:00Z" }), params))
      .status,
  ).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("clears dates and updates queued delivery in the edit transaction", async () => {
  expect(
    (
      await PATCH(
        request("PATCH", { startDate: null, endDate: null, isActive: false }),
        params,
      )
    ).status,
  ).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        startDate: null,
        endDate: null,
        isActive: false,
      }),
    }),
  );
  expect(mockStage).toHaveBeenCalledWith(mockTx, announcement, announcement);
});
it("rejects raw enum-shaped strings and unknown fields on edit", async () => {
  expect(
    (await PATCH(request("PATCH", { isActive: "false" }), params)).status,
  ).toBe(400);
  expect(
    (await PATCH(request("PATCH", { createdBy: "other" }), params)).status,
  ).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("deletes and cancels queued notices in the same transaction", async () => {
  expect((await DELETE(request("DELETE"), params)).status).toBe(200);
  expect(mockCancel).toHaveBeenCalledWith(mockTx, announcement.id);
  mockDelete.mockResolvedValueOnce({ count: 0 });
  expect((await DELETE(request("DELETE"), params)).status).toBe(404);
  expect(mockCancel).toHaveBeenCalledTimes(1);
});

it("returns a private error for a transient management read rather than an empty success", async () => {
  mockList.mockRejectedValueOnce(
    Object.assign(new Error("Timed out fetching a connection"), {
      code: "P2024",
    }),
  );
  const response = await GET(request("GET", undefined, "?view=manage"));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ success: false });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
