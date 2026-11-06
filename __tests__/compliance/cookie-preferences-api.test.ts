/** @jest-environment node */
const mockSession = jest.fn();
const mockRead = jest.fn();
const mockSave = jest.fn();
const mockTransaction = jest.fn();
const mockCookieSet = jest.fn();
const mockCookieGet = jest.fn();
const mockTx = {};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (...args: unknown[]) => mockTransaction(...args) },
}));
jest.mock("@/lib/auth-server", () => ({ getSession: () => mockSession() }));
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (...args: unknown[]) => mockCookieGet(...args),
    set: (...args: unknown[]) => mockCookieSet(...args),
  }),
}));
jest.mock("@/lib/compliance/cookie-preferences", () => ({
  readCookiePreferences: (...args: unknown[]) => mockRead(...args),
  saveCookiePreferences: (...args: unknown[]) => mockSave(...args),
}));
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/cookie-preferences/route";
beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockResolvedValue({ user: { id: "own" } });
  mockRead.mockResolvedValue({
    essential: true,
    analytics: false,
    marketing: false,
  });
  mockSave.mockResolvedValue({
    preferences: { essential: true, analytics: true, marketing: false },
  });
  mockTransaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
    run(mockTx),
  );
  mockCookieGet.mockReturnValue(undefined);
});
function update(body: unknown) {
  return PUT(
    new NextRequest("https://example.com/api/cookie-preferences", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );
}
it("writes through the supplied transaction with the authenticated identity", async () => {
  const response = await update({ analytics: true });
  expect(response.status).toBe(200);
  expect(mockSave).toHaveBeenCalledWith(
    mockTx,
    { userId: "own" },
    { analytics: true },
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(mockCookieSet).not.toHaveBeenCalled();
});
it.each([
  { essential: false },
  { userId: "other", analytics: true },
  {},
  { analytics: "yes" },
])("rejects invalid or caller-selected identity: %j", async (body) => {
  expect((await update(body)).status).toBe(400);
  expect(mockTransaction).not.toHaveBeenCalled();
});
it("reads an anonymous default without creating an identity and mints an opaque cookie only on save", async () => {
  mockSession.mockResolvedValue(null);
  expect(await (await GET()).json()).toEqual({
    essential: true,
    analytics: false,
    marketing: false,
  });
  expect(mockCookieSet).not.toHaveBeenCalled();
  expect((await update({ marketing: false })).status).toBe(200);
  expect(mockSave).toHaveBeenCalledWith(
    mockTx,
    { sessionId: expect.any(String) },
    { marketing: false },
  );
  expect(mockCookieSet).toHaveBeenCalledWith(
    "cp_sid",
    expect.any(String),
    expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
  );
});
it("does not acknowledge a failed commit", async () => {
  mockTransaction.mockRejectedValueOnce(new Error("commit unavailable"));
  expect((await update({ analytics: true })).status).toBe(503);
});
