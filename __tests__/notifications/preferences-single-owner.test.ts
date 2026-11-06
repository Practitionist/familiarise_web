/**
 * @jest-environment node
 */

/**
 * Postgres is the only owner of notification preferences: changing them is a
 * single database write, and the Inbox auth route only signs the session
 * user. None of these routes may reach the Novu API.
 */

const mockGetNovuClient = jest.fn();
const mockPreferenceUpsert = jest.fn();
const mockPreferenceFindUnique = jest.fn();
const mockProfileUpdate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockGetSession = jest.fn();

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: (...args: unknown[]) => mockGetNovuClient(...args),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationPreference: {
      upsert: (...args: unknown[]) => mockPreferenceUpsert(...args),
      findUnique: (...args: unknown[]) => mockPreferenceFindUnique(...args),
    },
    orgWorkspaceProfile: {
      update: (...args: unknown[]) => mockProfileUpdate(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
  },
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "u1", orgWorkspaceProfileId: "ows1" } },
  }),
}));
jest.mock("../../lib/data/org-workspace", () => ({
  getWorkspaceSettings: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { PUT as putPreferences } from "@/app/api/novu/preferences/route";
import { POST as postSubscriber } from "@/app/api/novu/subscriber/route";
import { PATCH as patchWorkspaceSettings } from "@/app/api/org-workspace/[orgWorkspaceId]/settings/route";

const OLD_DEV_KEY = process.env.NOVU_DEVELOPMENT_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "u1" } });
  process.env.NOVU_DEVELOPMENT_KEY = "sk_dev_single_owner";
});

afterAll(() => {
  if (OLD_DEV_KEY === undefined) delete process.env.NOVU_DEVELOPMENT_KEY;
  else process.env.NOVU_DEVELOPMENT_KEY = OLD_DEV_KEY;
});

function jsonRequest(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("preference writes never call Novu", () => {
  it("PUT /api/novu/preferences upserts the row and returns it", async () => {
    mockPreferenceUpsert.mockResolvedValue({
      userId: "u1",
      inAppEnabled: false,
    });

    const res = await putPreferences(
      jsonRequest("http://localhost/api/novu/preferences", "PUT", {
        inAppEnabled: false,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockPreferenceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        update: expect.objectContaining({ inAppEnabled: false }),
      }),
    );
    expect(mockGetNovuClient).not.toHaveBeenCalled();
  });

  it("PATCH workspace routing writes the profile and nothing else", async () => {
    mockProfileUpdate.mockResolvedValue({
      id: "ows1",
      notificationRoutingMode: "EMAIL_ONLY",
    });

    const res = await patchWorkspaceSettings(
      jsonRequest("http://localhost/api/org-workspace/ows1/settings", "PATCH", {
        notificationRoutingMode: "EMAIL_ONLY",
      }),
      { params: Promise.resolve({ orgWorkspaceId: "ows1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { notificationRoutingMode: "EMAIL_ONLY" },
      }),
    );
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockGetNovuClient).not.toHaveBeenCalled();
  });
});

describe("PUT /api/novu/preferences is strict", () => {
  const put = (body: unknown) =>
    putPreferences(
      jsonRequest("http://localhost/api/novu/preferences", "PUT", body),
    );

  it.each([
    ["an unknown key", { inAppEnabled: true, digest: true }],
    ["a column no sender reads", { pushEnabled: true }],
    ["a bad time", { quietHoursStart: "25:00" }],
    ["a partial time", { quietHoursEnd: "8:0" }],
    ["a bad timezone", { quietHoursTimezone: "Mars/Olympus_Mons" }],
    ["start == end", { quietHoursStart: "09:00", quietHoursEnd: "09:00" }],
  ])("refuses %s with 400 and writes nothing", async (_case, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(mockPreferenceUpsert).not.toHaveBeenCalled();
  });

  it("refuses a start equal to the stored (or default) end", async () => {
    mockPreferenceFindUnique.mockResolvedValue({
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    const res = await put({ quietHoursStart: "08:00" });
    expect(res.status).toBe(400);
    expect(mockPreferenceUpsert).not.toHaveBeenCalled();
  });

  it("accepts a valid quiet window and returns the full parsed row", async () => {
    mockPreferenceFindUnique.mockResolvedValue(null);
    mockPreferenceUpsert.mockResolvedValue({
      id: "p1",
      userId: "u1",
      quietHoursStart: "23:00",
      quietHoursTimezone: "Asia/Kolkata",
    });
    const res = await put({
      quietHoursStart: "23:00",
      quietHoursTimezone: "Asia/Kolkata",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      quietHoursStart: "23:00",
      allNotifications: true,
    });
    expect(body).not.toHaveProperty("userId");
  });
});

describe("POST /api/novu/subscriber", () => {
  it("returns the session user's HMAC without a Novu call or profile read", async () => {
    const res = await postSubscriber();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      subscriberHash: createHmac("sha256", "sk_dev_single_owner")
        .update("u1")
        .digest("hex"),
    });
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockGetNovuClient).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await postSubscriber();
    expect(res.status).toBe(401);
  });
});
