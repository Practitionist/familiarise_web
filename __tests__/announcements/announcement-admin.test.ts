/**
 * @jest-environment node
 */

/**
 * Admin announcement writes: links shown to every visitor must be http(s),
 * edits are validated, and the admin list includes inactive rows so they can
 * be re-activated.
 */

const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockGetSession = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    announcement: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: async () => 1,
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));
const mockManageRole = { current: "ADMIN" };
jest.mock("@/lib/auth-helpers", () => {
  const { NextResponse } =
    jest.requireActual<typeof import("next/server")>("next/server");
  const { hasBackofficePermission } = jest.requireActual<
    typeof import("@/lib/auth/backoffice-permissions")
  >("@/lib/auth/backoffice-permissions");
  return {
    requireBackofficeSurface: async (surface: "announcements.manage") =>
      hasBackofficePermission(mockManageRole.current as "ADMIN", surface)
        ? { session: { user: { id: "admin-1", role: mockManageRole.current } } }
        : { error: NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }) },
  };
});
jest.mock("@/lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));
jest.mock("next/cache", () => ({ revalidateTag: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/announcements/[id]/route";
import { GET as listForAdmin } from "@/app/api/announcements/manage/route";
import {
  CreateAnnouncementSchema,
  UpdateAnnouncementSchema,
} from "@/schemas/announcements";

const params = { params: Promise.resolve({ id: "ann-1" }) };

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/announcements/ann-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
  mockFindUnique.mockResolvedValue({ id: "ann-1" });
  mockUpdate.mockImplementation(async (args: { data: unknown }) => args.data);
});

describe("announcement link URLs", () => {
  it.each(["javascript:alert(1)", "data:text/html,hi", "ftp://x.test/a"])(
    "rejects %s on create and edit",
    (linkUrl) => {
      const create = CreateAnnouncementSchema.safeParse({
        title: "t",
        content: "c",
        linkUrl,
      });
      expect(create.success).toBe(false);
      expect(UpdateAnnouncementSchema.safeParse({ linkUrl }).success).toBe(
        false,
      );
    },
  );

  it("accepts an https link and a cleared link", () => {
    expect(
      UpdateAnnouncementSchema.safeParse({ linkUrl: "https://x.test/a" })
        .success,
    ).toBe(true);
    expect(UpdateAnnouncementSchema.safeParse({ linkUrl: null }).success).toBe(
      true,
    );
  });
});

describe("PATCH /api/announcements/[id]", () => {
  it("refuses a javascript: link without writing", async () => {
    const response = await PATCH(
      patchRequest({ linkUrl: "javascript:alert(1)" }),
      params,
    );

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses unknown fields", async () => {
    const response = await PATCH(patchRequest({ createdBy: "x" }), params);

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("writes only the fields sent and clears a date with null", async () => {
    const response = await PATCH(
      patchRequest({ isActive: false, endDate: null }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ann-1" },
      data: { isActive: false, endDate: null },
    });
  });
});

describe("GET /api/announcements/manage", () => {
  const list = (query = "") =>
    listForAdmin(
      new NextRequest(`http://localhost/api/announcements/manage${query}`),
    );

  beforeEach(() => {
    mockManageRole.current = "ADMIN";
  });

  it("lists inactive rows too, one page at a time, uncached", async () => {
    mockFindMany.mockResolvedValue([{ id: "ann-1", isActive: false }]);

    const response = await list("?page=2");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockFindMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: 20,
      take: 20,
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ id: "ann-1", isActive: false }],
      total: 1,
      page: 2,
      limit: 20,
    });
  });

  it.each(["STAFF", "CONSULTEE"])(
    "refuses %s on announcements.manage",
    async (role) => {
      mockManageRole.current = role;

      const response = await list();

      expect(response.status).toBe(403);
      expect(mockFindMany).not.toHaveBeenCalled();
    },
  );
});
