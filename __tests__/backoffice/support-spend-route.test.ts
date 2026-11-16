/**
 * @jest-environment node
 */

/**
 * The spend and audit API twins: `opsLog.read` gates both, a STAFF viewer
 * reads only their own spend row, and the audit query parses `action` and
 * `since` and refuses a bad date.
 */

import type { UserRole } from "@prisma/client";
import type { BackofficeSurface } from "../../lib/auth/backoffice-permissions";

const mockViewer: { id: string; role: UserRole } = {
  id: "staff-1",
  role: "STAFF",
};
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async (surface: BackofficeSurface) =>
    jest
      .requireActual<typeof import("../../lib/auth/backoffice-permissions")>(
        "../../lib/auth/backoffice-permissions",
      )
      .hasBackofficePermission(mockViewer.role, surface)
      ? { session: { user: { ...mockViewer } } }
      : {
          error: jest
            .requireActual<typeof import("next/server")>("next/server")
            .NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
        },
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
}));

const mockUsers = [
  { id: "staff-1", name: "Asha", role: "STAFF" },
  { id: "staff-2", name: "Bela", role: "STAFF" },
  { id: "admin-1", name: "Chitra", role: "ADMIN" },
];
const mockOpsFindMany = jest.fn(async (_args: unknown) => []);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findMany: async ({
        where,
        select,
      }: {
        where: { id?: string; role?: string | { in: string[] } };
        select?: { Payment?: unknown };
      }) =>
        // The target read (payments by buyer) finds none in these fixtures.
        select?.Payment
          ? []
          : mockUsers.filter(
              (u) =>
                (where.id === undefined || u.id === where.id) &&
                (where.role === undefined ||
                  (typeof where.role === "string"
                    ? u.role === where.role
                    : where.role.in.includes(u.role))),
            ),
      count: async () => mockUsers.length,
    },
    opsActionLog: {
      findMany: (args: unknown) => mockOpsFindMany(args),
      count: async () => 0,
    },
    supportFinancialRecommendation: { findMany: async () => [] },
    refund: { findMany: async () => [] },
    payment: { findMany: async () => [] },
  },
}));

import { NextRequest } from "next/server";
import { GET as getSpend } from "../../app/api/admin/support-spend/route";
import { GET as getOpsLog } from "../../app/api/admin/ops-actions/route";

beforeEach(() => {
  mockViewer.id = "staff-1";
  mockViewer.role = "STAFF";
  mockOpsFindMany.mockClear();
});

const spendRequest = () =>
  new NextRequest("http://localhost/api/admin/support-spend");

describe("GET /api/admin/support-spend", () => {
  it("gives staff their own row only", async () => {
    const res = await getSpend(spendRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { operators: { userId: string }[] };
    expect(body.operators.map((o) => o.userId)).toEqual(["staff-1"]);
    expect(mockOpsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorUserId: { in: ["staff-1"] } }),
      }),
    );
  });

  it("gives an admin every operator", async () => {
    mockViewer.id = "admin-1";
    mockViewer.role = "ADMIN";
    const body = (await (await getSpend(spendRequest())).json()) as {
      operators: { userId: string }[];
    };
    const ids = body.operators.map((o) => o.userId);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(
      expect.arrayContaining(["admin-1", "staff-1", "staff-2"]),
    );
  });

  it("keeps the page in the name order it was read in, whatever each spent", async () => {
    mockViewer.id = "admin-1";
    mockViewer.role = "ADMIN";
    mockOpsFindMany.mockResolvedValueOnce([
      {
        actorUserId: "staff-2",
        action: "support.refund.review",
        after: { approved: true, paymentId: "pay-1", movedPaise: 90_000 },
        createdAt: new Date(),
      },
    ] as never);
    const body = (await (await getSpend(spendRequest())).json()) as {
      operators: { name: string }[];
    };
    expect(body.operators.map((o) => o.name)).toEqual([
      "Asha",
      "Bela",
      "Chitra",
    ]);
  });

  it("refuses a non-operator", async () => {
    mockViewer.role = "CONSULTANT";
    expect((await getSpend(spendRequest())).status).toBe(403);
    expect(mockOpsFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/ops-actions", () => {
  const get = (query: string) =>
    getOpsLog(new NextRequest(`https://x.test/api/admin/ops-actions?${query}`));
  const lastWhere = () =>
    (mockOpsFindMany.mock.calls.at(-1)?.[0] as { where: unknown }).where;

  it("filters by action and since, and keeps staff on their own rows", async () => {
    const res = await get(
      "actorUserId=staff-2&action=support.refund.review&since=2026-09-22T02:00:00.000Z&surface=",
    );
    expect(res.status).toBe(200);
    expect(lastWhere()).toEqual({
      actorUserId: "staff-1",
      action: "support.refund.review",
      createdAt: { gte: new Date("2026-09-22T02:00:00.000Z") },
    });
  });

  it("lets an admin drill into another operator's rows", async () => {
    mockViewer.id = "admin-1";
    mockViewer.role = "ADMIN";
    await get("actorUserId=staff-2&action=support.hold.apply");
    expect(lastWhere()).toEqual({
      actorUserId: "staff-2",
      action: "support.hold.apply",
    });
  });

  it("refuses a since that is not a date", async () => {
    const res = await get("since=yesterday");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_QUERY");
    expect(mockOpsFindMany).not.toHaveBeenCalled();
  });
});
