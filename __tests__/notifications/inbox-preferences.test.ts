/** @jest-environment node */
const mockList = jest.fn();
const mockUpdate = jest.fn();
const mockBulk = jest.fn();
const mockSync = jest.fn();
const mockSession = jest.fn();
const mockUser = jest.fn();
let mockConfigured = true;
jest.mock("@/lib/novu/client", () => ({
  isNovuConfigured: () => mockConfigured,
  getNovuClient: () => ({
    subscribers: {
      preferences: {
        list: (...args: unknown[]) => mockList(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
        bulkUpdate: (...args: unknown[]) => mockBulk(...args),
      },
    },
  }),
}));
jest.mock("@/lib/novu/subscriber", () => ({
  syncSubscriber: (...args: unknown[]) => mockSync(...args),
}));
jest.mock("@/lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findFirst: (...args: unknown[]) => mockUser(...args) } },
}));
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/novu/preferences/inbox/route";
import {
  readInboxRestrictions,
  adoptFamiliariseInboxSettings,
} from "@/lib/novu/inbox-preferences";
const clear = {
  result: {
    global: { enabled: true, channels: { inApp: true } },
    workflows: [],
  },
};
const muted = {
  result: {
    global: { enabled: true, channels: { inApp: false } },
    workflows: [
      {
        enabled: true,
        channels: { inApp: false },
        workflow: { identifier: "payout", slug: "payout", name: "Payouts" },
      },
      {
        enabled: false,
        channels: {},
        workflow: { identifier: "unowned", slug: "custom", name: "Other" },
      },
    ],
  },
};
beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured = true;
  mockList.mockResolvedValue(clear);
  mockSync.mockResolvedValue(true);
  mockSession.mockResolvedValue({ user: { id: "own" } });
  mockUser.mockResolvedValue({ id: "own" });
});
it("reads existing independent vetoes without changing them or unrelated workflows", async () => {
  mockList.mockResolvedValue(muted);
  expect(await readInboxRestrictions("own")).toEqual({
    globalMuted: true,
    workflows: [{ id: "payout", name: "Payouts" }],
  });
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockBulk).not.toHaveBeenCalled();
  expect(mockSync).not.toHaveBeenCalled();
});
it("does not clear old restrictions when source synchronization fails", async () => {
  mockSync.mockResolvedValue(false);
  await expect(adoptFamiliariseInboxSettings("own")).rejects.toThrow(
    "synchronization",
  );
  expect(mockList).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockBulk).not.toHaveBeenCalled();
});
it("adopts only the in-app channel after explicit confirmation, then verifies the provider result", async () => {
  mockList.mockResolvedValueOnce(muted).mockResolvedValueOnce(clear);
  const response = await POST(
    new NextRequest("https://example.com/api/novu/preferences/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useFamiliariseSettings: true }),
    }),
  );
  expect(response.status).toBe(200);
  expect(mockBulk).toHaveBeenCalledWith(
    { preferences: [{ workflowId: "payout", channels: { inApp: true } }] },
    "own",
  );
  expect(mockUpdate).toHaveBeenCalledWith({ channels: { inApp: true } }, "own");
  expect(mockSync.mock.invocationCallOrder[0]).toBeLessThan(
    mockBulk.mock.invocationCallOrder[0],
  );
});
it("refuses caller-supplied user IDs and missing confirmation", async () => {
  const response = await POST(
    new NextRequest("https://example.com/api/novu/preferences/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useFamiliariseSettings: true, userId: "other" }),
    }),
  );
  expect(response.status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("reports retained vetoes and unknown provider outcomes instead of claiming success", async () => {
  mockList.mockResolvedValue(muted);
  expect(
    (
      await POST(
        new NextRequest("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ useFamiliariseSettings: true }),
        }),
      )
    ).status,
  ).toBe(409);
  mockList.mockRejectedValueOnce(new Error("timeout"));
  expect((await GET()).status).toBe(503);
});
it("requires a current verified, unerased account and does not treat missing configuration as no restrictions", async () => {
  mockUser.mockResolvedValueOnce(null);
  expect((await GET()).status).toBe(401);
  expect(mockList).not.toHaveBeenCalled();
  mockConfigured = false;
  expect((await GET()).status).toBe(503);
  expect(mockUser).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "own", erasedAt: null, emailVerified: true },
    }),
  );
});

it("refuses a simple cross-origin form-style confirmation", async () => {
  const response = await POST(
    new NextRequest("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ useFamiliariseSettings: true }),
    }),
  );
  expect(response.status).toBe(415);
  expect(mockSync).not.toHaveBeenCalled();
  expect(mockBulk).not.toHaveBeenCalled();
});
