/**
 * @jest-environment node
 */

/**
 * The CERT-In access log: every way a session ends is stamped with its reason,
 * a write failure never fails the auth action, and Better Auth's real endpoint
 * paths map to the reasons the hooks record.
 */

const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
}));

const db = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  session: { findMany: jest.fn(), deleteMany: jest.fn() },
  sessionAccessLog: { createMany: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  endReasonForPath,
  recordSessionEnds,
  recordSessionStart,
  type SessionSnapshot,
} from "../../lib/auth/session-access-log";
import { revokeSessionById } from "../../lib/auth/session-revoke";
import type { PrismaLike } from "../../lib/prisma";

const NOW = new Date("2026-11-02T10:00:00Z");
const live: SessionSnapshot = {
  id: "s-live",
  userId: "u1",
  ipAddress: "203.0.113.7",
  userAgent: "Firefox",
  createdAt: new Date("2026-11-01T10:00:00Z"),
  expiresAt: new Date("2026-12-01T10:00:00Z"),
};
const lapsed: SessionSnapshot = {
  ...live,
  id: "s-lapsed",
  expiresAt: new Date("2026-11-02T09:00:00Z"),
};
const client = db as unknown as PrismaLike;
// $executeRaw is a template tag: the VALUES rows arrive as the first interpolation.
const stamped = () =>
  (db.$executeRaw.mock.calls.at(-1)?.[1] as { values: unknown[] }).values;

beforeEach(() => {
  jest.clearAllMocks();
  db.$queryRaw.mockResolvedValue([{ ready: true }]);
  db.$executeRaw.mockResolvedValue(1);
});

describe("session access log writes", () => {
  it("writes nothing, and keeps the action alive, until the table exists", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ ready: false }]);
    await expect(
      recordSessionEnds(client, [live], "SIGN_OUT", NOW),
    ).resolves.toBe(false);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([
    ["a live row signed out", live, "SIGN_OUT", NOW, "SIGN_OUT"],
    ["a live row revoked", live, "REVOKED", NOW, "REVOKED"],
    [
      "a lapsed row presented as a cookie",
      lapsed,
      "EXPIRED_COOKIE",
      lapsed.expiresAt,
      "EXPIRED_COOKIE",
    ],
    ["a lapsed row revoked", lapsed, "REVOKED", lapsed.expiresAt, "EXPIRED"],
    ["a lapsed row swept", lapsed, "EXPIRED", lapsed.expiresAt, "EXPIRED"],
    ["an unclassified delete", live, "UNKNOWN", NOW, "UNKNOWN"],
  ] as const)("stamps %s", async (_label, row, reason, endedAt, endReason) => {
    await expect(recordSessionEnds(client, [row], reason, NOW)).resolves.toBe(
      true,
    );
    expect(stamped()).toEqual(
      expect.arrayContaining([
        row.id,
        row.ipAddress,
        row.createdAt,
        endedAt,
        endReason,
      ]),
    );
  });

  it("never throws on a failed write and reports to Sentry once per process", async () => {
    db.$executeRaw.mockRejectedValue(new Error("connection reset"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordSessionEnds(client, [live], "SIGN_OUT", NOW),
    ).resolves.toBe(false);
    await expect(recordSessionStart(live)).resolves.toBeUndefined();
    await expect(
      recordSessionEnds(client, [live], "REVOKED", NOW),
    ).resolves.toBe(false);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });

  it("logs a start once per session with the full stamped client IP", async () => {
    db.sessionAccessLog.createMany.mockResolvedValue({ count: 1 });
    await recordSessionStart(
      { ...live, ipAddress: "2001:db8:1:2:0:0:0:0" },
      new Headers({ "x-familiarise-client-ip": "2001:db8:1:2::abcd" }),
    );
    expect(db.sessionAccessLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          sessionId: "s-live",
          userId: "u1",
          ipAddress: "2001:db8:1:2::abcd",
          userAgent: "Firefox",
          startedAt: live.createdAt,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("an app revoke reads, deletes and stamps with the caller's predicate", async () => {
    db.session.findMany.mockResolvedValue([live]);
    db.session.deleteMany.mockResolvedValue({ count: 1 });
    await expect(revokeSessionById(client, "u1", "s-live")).resolves.toEqual({
      revoked: 1,
    });
    const where = { id: "s-live", userId: "u1" };
    expect(db.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where });
    expect(stamped()).toContain("REVOKED");
  });
});

describe("Better Auth 1.7.7 delete paths on a real instance", () => {
  const APP = "http://localhost:3000";
  const mem = {
    user: [] as Record<string, unknown>[],
    session: [] as Record<string, unknown>[],
    account: [] as Record<string, unknown>[],
    verification: [] as Record<string, unknown>[],
  };
  const started: string[] = [];
  const ended: string[] = [];
  const auth = betterAuth({
    secret: "test-secret-that-is-at-least-32-characters",
    baseURL: APP,
    database: memoryAdapter(mem),
    emailAndPassword: { enabled: true },
    databaseHooks: {
      session: {
        create: { after: async (s) => void started.push(s.id) },
        delete: {
          after: async (_s, ctx) =>
            void ended.push(endReasonForPath(ctx?.path)),
        },
      },
    },
  });
  const call = (path: string, body?: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${APP}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: APP,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const cookieOf = (res: Response) =>
    (res.headers.get("set-cookie") ?? "")
      .split(/,(?=\s*[\w.-]+=)/)
      .map((c) => c.split(";")[0].trim())
      .filter((c) => c.includes("session_token="))
      .join("; ");
  const credentials = { email: "a@example.test", password: "correct-horse-1" };
  const signIn = async () =>
    cookieOf(await call("/sign-in/email", credentials));

  it("classifies sign-out, an expired cookie and a revocation", async () => {
    await call("/sign-up/email", { ...credentials, name: "A" });

    await call("/sign-out", {}, await signIn());
    const expiring = await signIn();
    for (const row of mem.session) row.expiresAt = new Date(Date.now() - 1000);
    await call("/get-session", undefined, expiring);
    await signIn();
    await call("/revoke-other-sessions", {}, await signIn());

    expect(started.length).toBeGreaterThanOrEqual(4);
    expect(ended).toEqual(["SIGN_OUT", "EXPIRED_COOKIE", "REVOKED"]);
  });
});
