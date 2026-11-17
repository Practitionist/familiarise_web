/**
 * @jest-environment node
 */

/**
 * #1270 — a permanent ban could not be lifted.
 *
 * USER_BANNED calls `chat.deactivateUser`, which is permanent, and
 * `restoreStreamAccess` — the documented inverse — had zero callers. An admin
 * reversing a wrongful ban by clearing `User.banned` produced an account that
 * could sign in, book and pay but could never connect to chat again, with
 * nothing anywhere explaining why.
 *
 * `hasBackofficePermission` is deliberately NOT mocked: the point of the gate
 * is the real matrix, and a mocked one would pass whatever it was told.
 */

type ActionCreateArgs = {
  data: { reportId: string; actionType: string; takenById: string };
};

const tx = {
  user: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findMany: jest.fn(async () => []),
  },
  moderationAction: {
    create: jest.fn(async ({ data }: ActionCreateArgs) => ({
      id: "action-1",
      ...data,
    })),
  },
  notificationOutbox: {
    upsert: jest.fn(async () => null),
  },
};

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: {
      findUnique: jest.fn(async () => ({ id: "r1", targetUserId: "u1" })),
    },
    opsActionLog: { create: jest.fn(async () => ({ id: "ops-1" })) },
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  },
}));

const mockRole: { current: "ADMIN" | "STAFF" } = { current: "ADMIN" };
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: jest.fn(async (surface: string) => {
    const { hasBackofficePermission } = jest.requireActual<
      typeof import("../../lib/auth/backoffice-permissions")
    >("../../lib/auth/backoffice-permissions");
    const { NextResponse } =
      jest.requireActual<typeof import("next/server")>("next/server");
    return hasBackofficePermission(mockRole.current, surface as never)
      ? {
          session: {
            user: {
              id: `${mockRole.current}-1`.toLowerCase(),
              role: mockRole.current,
            },
          },
        }
      : { error: NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }) };
  }),
}));

jest.mock("../../lib/moderation/side-effects", () => ({
  __esModule: true,
  restoreStreamAccess: jest.fn(async () => undefined),
  persistActionSideEffects: jest.fn(async () => undefined),
}));

import { POST } from "../../app/api/staff/moderation/reports/[reportId]/unban/route";
import { requireBackofficeSurface } from "../../lib/auth-helpers";
import prisma from "../../lib/prisma";
import {
  persistActionSideEffects,
  restoreStreamAccess,
} from "../../lib/moderation/side-effects";

const mockedAuth = requireBackofficeSurface as jest.Mock;
const mockedRestore = restoreStreamAccess as jest.Mock;
const mockedPersist = persistActionSideEffects as jest.Mock;

const call = (notes = "wrongful ban") =>
  POST(
    new Request("http://localhost/unban", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes, reason: "The ban was a mistake" }),
    }) as never,
    { params: Promise.resolve({ reportId: "r1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockRole.current = "ADMIN";
  mockedRestore.mockResolvedValue(undefined);
});

describe("POST /api/staff/moderation/reports/[reportId]/unban", () => {
  it("refuses a staff moderator — reversing a ban is as destructive as taking one", async () => {
    mockRole.current = "STAFF";

    const res = await call();

    expect(mockedAuth).toHaveBeenCalledWith("users.moderate", {
      expectUser: true,
    });
    expect(res.status).toBe(403);
    expect(mockedRestore).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("clears the ban columns, records who did it, and restores Stream access", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", banned: true },
      data: { banned: false, banReason: null, banExpires: null },
    });
    expect(tx.moderationAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "USER_REINSTATED",
          takenById: "admin-1",
          reportId: "r1",
        }),
      }),
    );
    expect(mockedRestore).toHaveBeenCalledWith("u1");
    expect(await res.json()).toMatchObject({ sideEffects: { stream: "ok" } });
  });

  it("says so when the ban was lifted but Stream never heard about it", async () => {
    mockedRestore.mockRejectedValue(new Error("Stream is down"));

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sideEffects.stream).toBe("failed");
    expect(body.sideEffects.errors[0]).toContain("Stream is down");
    // Persisted too, so the report keeps showing the gap after the toast is gone.
    expect(mockedPersist).toHaveBeenCalledWith(
      "action-1",
      expect.objectContaining({ stream: "failed" }),
    );
  });

  it("404s on an unknown report before touching anything", async () => {
    (prisma.moderationReport.findUnique as jest.Mock).mockResolvedValueOnce(
      null,
    );

    const res = await call();

    expect(res.status).toBe(404);
    expect(mockedRestore).not.toHaveBeenCalled();
  });
});
