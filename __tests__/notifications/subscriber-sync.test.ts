/** @jest-environment node */
import { z } from "zod";
const mockCreate = jest.fn();
let mockConfigured = true;
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/novu/client", () => ({
  isNovuConfigured: () => mockConfigured,
  getNovuClient: () => ({
    subscribers: { create: (...args: unknown[]) => mockCreate(...args) },
  }),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NotificationPreferenceSchema } from "@/schemas/user";
import {
  attemptSubscriberSync,
  drainSubscriberSyncs,
  stageSubscriberSync,
  type SubscriberSyncStore,
} from "@/lib/novu/subscriber";

function fixture() {
  const prefs = {
    ...NotificationPreferenceSchema.parse({}),
    novuSyncToken: "revision-1",
    novuSyncPendingAt: new Date(),
  };
  const user: NonNullable<
    Awaited<ReturnType<SubscriberSyncStore["user"]["findUnique"]>>
  > = {
    id: "recipient",
    email: "recipient@example.com",
    emailVerified: true,
    name: "Asha Rao",
    phone: null,
    image: null,
    erasedAt: null,
    consentArtifacts: [],
    orgWorkspaceProfile: {
      notificationRoutingMode: "BELL_AND_EMAIL",
      locale: "en-IN",
    },
    notificationPreferences: prefs,
  };
  const changes = z.object({
    novuSyncToken: z.string().nullable(),
    novuSyncPendingAt: z.date().nullable(),
  });
  const db: SubscriberSyncStore = {
    user: { findUnique: jest.fn(async () => structuredClone(user)) },
    notificationPreference: {
      upsert: jest.fn(async (args) => {
        Object.assign(prefs, args.update);
        return { userId: args.where.userId };
      }),
      updateMany: jest.fn(async (args) => {
        if (args.where?.user && user.erasedAt) return { count: 0 };
        if (args.where?.novuSyncToken !== prefs.novuSyncToken)
          return { count: 0 };
        Object.assign(prefs, changes.partial().parse(args.data));
        return { count: 1 };
      }),
      findMany: jest.fn(async () => [{ userId: user.id }]),
    },
  };
  return { db, user, prefs };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured = true;
  mockCreate.mockResolvedValue({});
});

describe("recoverable Novu subscriber synchronization", () => {
  it("never mirrors a marketing boolean as consent without a current artifact", async () => {
    const { db, user, prefs } = fixture();
    prefs.marketingEmails = true;
    await attemptSubscriberSync("recipient", db);
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ categoryMarketing: false }),
      }),
    );
    user.consentArtifacts = [{ id: "current-grant" }];
    await stageSubscriberSync("recipient", db);
    await attemptSubscriberSync("recipient", db);
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ categoryMarketing: true }),
      }),
    );
  });
  it("stages a unique pending revision using the supplied transaction", async () => {
    const { db, prefs } = fixture();
    await stageSubscriberSync("recipient", db);
    const first = prefs.novuSyncToken;
    await stageSubscriberSync("recipient", db);
    expect(prefs.novuSyncToken).not.toBe(first);
    expect(db.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "recipient",
          novuSyncToken: expect.any(String),
          novuSyncPendingAt: expect.any(Date),
        }),
        update: expect.objectContaining({ novuSyncToken: prefs.novuSyncToken }),
      }),
    );
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("loads current settings and acknowledges only after provider success", async () => {
    const { db, prefs } = fixture();
    prefs.allNotifications = false;
    prefs.paymentNotifications = false;
    await attemptSubscriberSync("recipient", db);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: "recipient",
        email: "recipient@example.com",
        data: expect.objectContaining({
          masterEnabled: false,
          categoryPayments: false,
          categoryMarketing: false,
        }),
      }),
    );
    expect(db.notificationPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: "recipient", novuSyncToken: "revision-1" },
      data: { novuSyncToken: null, novuSyncPendingAt: null },
    });
    expect(prefs.novuSyncToken).toBeNull();
  });

  it("retains durable work after a failed provider call", async () => {
    const { db, prefs } = fixture();
    mockCreate.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(attemptSubscriberSync("recipient", db)).rejects.toThrow(
      "provider unavailable",
    );
    expect(prefs.novuSyncToken).toBe("revision-1");
    expect(prefs.novuSyncPendingAt).toBeInstanceOf(Date);
    expect(db.notificationPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: "recipient", novuSyncToken: "revision-1" },
      data: { novuSyncPendingAt: expect.any(Date) },
    });
  });

  it("never authorizes a vendor write after a failed source read", async () => {
    const { db, prefs } = fixture();
    jest
      .mocked(db.user.findUnique)
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(attemptSubscriberSync("recipient", db)).rejects.toThrow(
      "database unavailable",
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(prefs.novuSyncToken).toBe("revision-1");
  });

  it("cannot clear a newer pending preference update", async () => {
    const { db, prefs } = fixture();
    mockCreate.mockImplementationOnce(async () => {
      prefs.novuSyncToken = "revision-2";
      prefs.allNotifications = false;
    });
    await attemptSubscriberSync("recipient", db);
    expect(prefs.novuSyncToken).toBe("revision-2");
  });

  it("requeues current settings when an old in-flight write finishes after a newer acknowledgement", async () => {
    const { db, prefs } = fixture();
    let releaseOld = () => {};
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    mockCreate.mockImplementationOnce(async () => {
      started();
      await gate;
    });
    const oldAttempt = attemptSubscriberSync("recipient", db);
    await entered;
    prefs.novuSyncToken = "revision-2";
    prefs.allNotifications = false;
    await attemptSubscriberSync("recipient", db);
    expect(prefs.novuSyncToken).toBeNull();
    releaseOld();
    await oldAttempt;
    expect(prefs.novuSyncToken).not.toBeNull();
    await attemptSubscriberSync("recipient", db);
    expect(mockCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ masterEnabled: false }),
      }),
    );
    expect(prefs.novuSyncToken).toBeNull();
  });

  it("does not recreate erased recipients", async () => {
    const { db, user, prefs } = fixture();
    user.erasedAt = new Date();
    await attemptSubscriberSync("recipient", db);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(prefs.novuSyncToken).toBeNull();
  });

  it("keeps an unverified account pending without provisioning its address", async () => {
    const { db, user, prefs } = fixture();
    user.emailVerified = false;
    expect(await attemptSubscriberSync("recipient", db)).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(prefs.novuSyncToken).toBe("revision-1");
    user.emailVerified = true;
    expect(await attemptSubscriberSync("recipient", db)).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(prefs.novuSyncToken).toBeNull();
  });

  it("does not acknowledge an unconfigured provider", async () => {
    const { db, prefs } = fixture();
    mockConfigured = false;
    await expect(attemptSubscriberSync("recipient", db)).resolves.toBe(false);
    expect(prefs.novuSyncToken).toBe("revision-1");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("drains a bounded pending slice without capturing one error per user", async () => {
    const { db, prefs } = fixture();
    mockCreate.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(drainSubscriberSyncs(db, 3)).resolves.toEqual({
      scanned: 1,
      synced: 0,
      pending: 0,
      failures: 1,
    });
    expect(db.notificationPreference.findMany).toHaveBeenCalledWith({
      where: {
        novuSyncPendingAt: { not: null },
        user: { emailVerified: true, erasedAt: null },
      },
      orderBy: { novuSyncPendingAt: "asc" },
      take: 3,
      select: { userId: true },
    });
    expect(prefs.novuSyncToken).toBe("revision-1");
  });
});
