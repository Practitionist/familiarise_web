/** @jest-environment node */
import { NextRequest } from "next/server";
const mockAttemptSync = jest.fn();
const mockTransaction = jest.fn();
const mockPreferenceRead = jest.fn();
const mockConsentRead = jest.fn();
const mockGlobalWrite = jest.fn((...args: unknown[]) => {
  throw new Error(
    `global client used inside transaction (${args.length} arguments)`,
  );
});
const mockTx = {
  notificationPreference: { upsert: jest.fn() },
  consentArtifact: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  waitlist: { updateMany: jest.fn() },
  cookiePreference: {
    findUnique: jest.fn(async () => ({ analytics: false, marketing: false })),
    upsert: jest.fn(),
    updateMany: jest.fn(),
  },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    notificationPreference: {
      findUnique: (...args: unknown[]) => mockPreferenceRead(...args),
      upsert: (...args: unknown[]) => mockGlobalWrite(...args),
    },
    consentArtifact: {
      findFirst: (...args: unknown[]) => mockConsentRead(...args),
    },
  },
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: async () => ({ user: { id: "account" } }),
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "account" } },
    error: null,
  }),
}));
jest.mock("@/lib/novu/subscriber", () => ({
  subscriberSyncMark: () => ({
    novuSyncToken: "pending",
    novuSyncPendingAt: new Date("2026-11-05T00:00:00Z"),
  }),
  attemptSubscriberSync: (...args: unknown[]) => mockAttemptSync(...args),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NotificationPreferenceSchema } from "@/schemas/user";
import { TERMS_VERSION } from "@/lib/compliance/purpose-codes";
import { GET, PUT } from "@/app/api/novu/preferences/route";
import {
  POST as grantPersonal,
  DELETE as withdrawPersonal,
} from "@/app/api/user/privacy/consent/route";

let preferences = NotificationPreferenceSchema.parse({});
let currentGrant: Record<string, unknown> | null = null;

function update(data: Record<string, unknown>) {
  return PUT(
    new NextRequest("https://example.com/api/novu/preferences", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  preferences = NotificationPreferenceSchema.parse({});
  currentGrant = null;
  mockTransaction.mockImplementation(
    async (run: (tx: typeof mockTx) => Promise<unknown>) => run(mockTx),
  );
  mockTx.notificationPreference.upsert.mockImplementation(
    async ({ update }: { update: Record<string, unknown> }) => {
      Object.assign(preferences, update);
      return { ...preferences };
    },
  );
  mockTx.consentArtifact.findFirst.mockImplementation(
    async (args: { where: { purposeCodes: { hasSome: string[] } } }) =>
      args.where.purposeCodes.hasSome.includes("MARKETING_COMMS") &&
      currentGrant?.withdrawnAt === null
        ? currentGrant
        : null,
  );
  mockTx.consentArtifact.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      const grant = {
        id: `grant-${mockTx.consentArtifact.create.mock.calls.length}`,
        ...data,
        withdrawnAt: null,
      };
      if (
        Array.isArray(data.purposeCodes) &&
        data.purposeCodes.includes("MARKETING_COMMS")
      )
        currentGrant = grant;
      return grant;
    },
  );
  mockTx.consentArtifact.findMany.mockResolvedValue([]);
  mockTx.consentArtifact.updateMany.mockImplementation(async () => {
    const count = currentGrant ? 1 : 0;
    if (currentGrant)
      currentGrant = { ...currentGrant, withdrawnAt: new Date() };
    return { count };
  });
  mockTx.user.findUnique.mockResolvedValue({ email: "reader@example.com" });
  mockTx.waitlist.updateMany.mockResolvedValue({ count: 1 });
  mockTx.cookiePreference.upsert.mockResolvedValue({});
  mockTx.cookiePreference.updateMany.mockResolvedValue({ count: 1 });
  mockPreferenceRead.mockImplementation(async () => ({
    ...preferences,
    novuSyncToken: "internal",
    novuSyncPendingAt: new Date(),
  }));
  mockConsentRead.mockImplementation(async () =>
    currentGrant?.withdrawnAt === null ? currentGrant : null,
  );
  mockAttemptSync.mockResolvedValue(true);
});

describe("one account marketing choice across settings and privacy", () => {
  it("does not present a legacy boolean as consent or expose internal sync state", async () => {
    preferences.marketingEmails = true;
    const response = await GET();
    expect(await response.json()).toEqual(
      NotificationPreferenceSchema.parse({ marketingEmails: false }),
    );
    expect(mockConsentRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dataFiduciary: "Familiarise",
          version: TERMS_VERSION,
          withdrawnAt: null,
        }),
      }),
    );
  });

  it("commits a versioned grant with the setting and never enables cookies or enrolls an address", async () => {
    const response = await update({ marketingEmails: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ marketingEmails: true });
    expect(mockTx.consentArtifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "account",
        purposeCodes: ["MARKETING_COMMS"],
        dataFiduciary: "Familiarise",
        version: TERMS_VERSION,
      }),
    });
    expect(mockTx.cookiePreference.upsert).not.toHaveBeenCalled();
    expect(mockTx.waitlist.updateMany).not.toHaveBeenCalled();
    expect(mockGlobalWrite).not.toHaveBeenCalled();
    expect(mockAttemptSync).toHaveBeenCalledWith("account");
    await update({ marketingEmails: true });
    expect(mockTx.consentArtifact.create).toHaveBeenCalledTimes(1);
  });

  it("withdraws only the platform purpose and current-address enrollment in the same transaction", async () => {
    await update({ marketingEmails: true });
    const response = await update({ marketingEmails: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ marketingEmails: false });
    expect(mockTx.consentArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "account",
          dataFiduciary: "Familiarise",
          purposeCodes: {
            hasSome: expect.arrayContaining(["MARKETING_COMMS"]),
          },
        }),
        data: expect.objectContaining({
          withdrawnAt: expect.any(Date),
          auditRetainedUntil: expect.any(Date),
        }),
      }),
    );
    expect(mockTx.waitlist.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: { equals: "reader@example.com", mode: "insensitive" },
          status: { in: ["PENDING", "SUBSCRIBED"] },
        },
        data: expect.objectContaining({ status: "UNSUBSCRIBED" }),
      }),
    );
    expect(mockTx.cookiePreference.updateMany).not.toHaveBeenCalled();
    await update({ marketingEmails: true });
    expect(mockTx.consentArtifact.create).toHaveBeenCalledTimes(2);
    expect(mockTx.waitlist.updateMany).toHaveBeenCalledTimes(1);
  });

  it("keeps channel muting separate from withdrawing purpose consent", async () => {
    await update({ marketingEmails: true });
    await update({ emailEnabled: false });
    expect(mockTx.consentArtifact.updateMany).not.toHaveBeenCalled();
    expect(mockTx.waitlist.updateMany).not.toHaveBeenCalled();
    expect(preferences.marketingEmails).toBe(true);
  });

  it("does not start provider work after a failed commit", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("commit failed"));
    const response = await update({ marketingEmails: true });
    expect(response.status).toBe(500);
    expect(mockAttemptSync).not.toHaveBeenCalled();
  });

  it("creates one artifact per purpose on the personal route", async () => {
    const response = await grantPersonal(
      new NextRequest("https://example.com/api/user/privacy/consent", {
        method: "POST",
        body: JSON.stringify({
          purposeCodes: ["MARKETING_COMMS", "ANALYTICS"],
          version: TERMS_VERSION,
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).consents).toHaveLength(2);
    for (const [args] of mockTx.consentArtifact.create.mock.calls)
      expect(args.data.purposeCodes).toHaveLength(1);
    expect(mockTx.cookiePreference.upsert).toHaveBeenCalledTimes(1);
    expect(mockTx.cookiePreference.upsert).toHaveBeenCalledWith({
      where: { userId: "account" },
      create: { userId: "account", analytics: true, essential: true },
      update: { analytics: true, essential: true },
    });
  });

  it("refuses a grant for a notice version the current UI does not display", async () => {
    const response = await grantPersonal(
      new NextRequest("https://example.com/api/user/privacy/consent", {
        method: "POST",
        body: JSON.stringify({
          purposeCodes: ["MARKETING_COMMS"],
          version: TERMS_VERSION + 1,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("uses the same scoped withdrawal through the privacy route", async () => {
    await update({ marketingEmails: true });
    const response = await withdrawPersonal(
      new NextRequest(
        "https://example.com/api/user/privacy/consent?purposeCode=marketing",
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      withdrawnCount: 1,
      purposeCode: "MARKETING_COMMS",
    });
    expect(preferences.marketingEmails).toBe(false);
    expect(mockTx.cookiePreference.updateMany).not.toHaveBeenCalled();
  });
});
