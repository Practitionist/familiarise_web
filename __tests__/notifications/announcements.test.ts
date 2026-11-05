/** @jest-environment node */
const mockCreate = jest.fn();
const mockNotify = jest.fn();
const mockFlush = jest.fn();
const mockTx = { announcement: { create: mockCreate } };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  },
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: async () => ({ user: { id: "admin", role: "ADMIN" } }),
}));
jest.mock("../../lib/novu", () => ({
  notifyGeneralAnnouncement: (...args: unknown[]) => mockNotify(...args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
import { NextRequest } from "next/server";
import { POST } from "@/app/api/announcements/route";

beforeEach(() => {
  jest.clearAllMocks();
  mockNotify.mockResolvedValue({ success: true, staged: { id: "bell" } });
});
const announcement = {
  id: "announcement-one",
  title: "News",
  content: "Details",
  isActive: true,
  startDate: null,
  endDate: null,
};
function request() {
  return new NextRequest("https://app.test/api/announcements", {
    method: "POST",
    body: JSON.stringify({ title: "News", content: "Details" }),
  });
}

it.each([
  { isActive: false },
  { startDate: new Date(Date.now() + 86400000) },
  { endDate: new Date(Date.now() - 86400000) },
])(
  "does not broadcast an inactive, future or expired announcement: %j",
  async (patch) => {
    mockCreate.mockResolvedValue({ ...announcement, ...patch });
    expect((await POST(request())).status).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  },
);

it("stages a live announcement in its transaction using its identity", async () => {
  mockCreate.mockResolvedValue(announcement);
  expect((await POST(request())).status).toBe(200);
  expect(mockNotify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "News" }),
    expect.objectContaining({
      tx: mockTx,
      dedupeKey: "announcement:announcement-one",
    }),
  );
  expect(mockFlush).toHaveBeenCalledWith(
    { bells: [{ id: "bell" }] },
    "announcements.create",
  );
});

it("fails the transaction rather than claiming success when staging rejects", async () => {
  mockCreate.mockResolvedValue(announcement);
  mockNotify.mockRejectedValue(new Error("outbox write failed"));
  expect((await POST(request())).status).toBe(500);
  expect(mockFlush).not.toHaveBeenCalled();
});
