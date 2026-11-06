/**
 * @jest-environment node
 */

const mockSubscriberCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockAttemptTrigger = jest.fn();
const mockAttemptStaged = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: jest.fn(() => {
    throw new Error("after() called outside request scope");
  }),
}));

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    notificationOutbox: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    subscribers: {
      create: (...args: unknown[]) => mockSubscriberCreate(...args),
    },
  }),
}));

jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: (...args: unknown[]) => mockAttemptStaged(...args),
}));

jest.mock("../../lib/novu/outbox", () => {
  const actual = jest.requireActual<typeof import("../../lib/novu/outbox")>(
    "../../lib/novu/outbox",
  );
  return {
    ...actual,
    attemptTrigger: (...args: unknown[]) => mockAttemptTrigger(...args),
  };
});

import { createHmac } from "node:crypto";
import { stageBell } from "@/lib/novu/stage-bell";
import {
  buildSubscriberCustomData,
  computeSubscriberHash,
  updateSubscriberPreferences,
} from "@/lib/novu/subscriber";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import type { StagedTrigger } from "@/lib/novu/outbox";

const OLD_DEV_KEY = process.env.NOVU_DEVELOPMENT_KEY;
const OLD_PROD_KEY = process.env.NOVU_PRODUCTION_KEY;
const OLD_SENTRY_ENV = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  if (OLD_DEV_KEY === undefined) delete process.env.NOVU_DEVELOPMENT_KEY;
  else process.env.NOVU_DEVELOPMENT_KEY = OLD_DEV_KEY;

  if (OLD_PROD_KEY === undefined) delete process.env.NOVU_PRODUCTION_KEY;
  else process.env.NOVU_PRODUCTION_KEY = OLD_PROD_KEY;

  if (OLD_SENTRY_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
  } else {
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = OLD_SENTRY_ENV;
  }
});

describe("1. stageBell(tx, ...) preference gating, routing mode & quiet hours", () => {
  it("never schedules a delayed survey earlier than its explicit receipt window", async () => {
    const tx = {
      user: {
        findMany: jest.fn(async () => [
          {
            id: "recipient",
            timezone: "UTC",
            notificationPreferences: {
              allNotifications: true,
              inAppEnabled: true,
            },
          },
        ]),
      },
      notificationOutbox: {
        upsert: jest.fn(async ({ create }) => ({ id: "scheduled", ...create })),
      },
    };
    const notBefore = new Date(Date.now() + 24 * 3_600_000);
    await stageBell(tx as never, {
      workflowId: "support-ticket-update",
      recipients: ["recipient"],
      payload: { ticketId: "case", status: "Resolved" },
      dedupeKey: "survey",
      notBefore,
    });
    expect(tx.notificationOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ notBefore }),
      }),
    );
  });

  it("filters out EMAIL_ONLY, NEITHER, allNotifications:false, inAppEnabled:false, and muted categories, computes quiet-hours notBefore, and returns null when all opt out", async () => {
    const txFindMany = jest.fn().mockResolvedValue([
      {
        id: "u_allowed_quiet",
        timezone: "UTC",
        orgWorkspaceProfile: { notificationRoutingMode: "BELL_AND_EMAIL" },
        notificationPreferences: {
          allNotifications: true,
          inAppEnabled: true,
          paymentNotifications: true,
          quietHoursEnabled: true,
          quietHoursStart: "00:00",
          quietHoursEnd: "23:59",
          quietHoursTimezone: "UTC",
        },
      },
      {
        id: "u_email_only",
        orgWorkspaceProfile: { notificationRoutingMode: "EMAIL_ONLY" },
        notificationPreferences: { allNotifications: true, inAppEnabled: true },
      },
      {
        id: "u_neither",
        orgWorkspaceProfile: { notificationRoutingMode: "NEITHER" },
        notificationPreferences: { allNotifications: true, inAppEnabled: true },
      },
      {
        id: "u_all_off",
        orgWorkspaceProfile: { notificationRoutingMode: "BELL_ONLY" },
        notificationPreferences: {
          allNotifications: false,
          inAppEnabled: true,
        },
      },
      {
        id: "u_inapp_off",
        orgWorkspaceProfile: { notificationRoutingMode: "BELL_AND_EMAIL" },
        notificationPreferences: {
          allNotifications: true,
          inAppEnabled: false,
        },
      },
      {
        id: "u_cat_muted",
        orgWorkspaceProfile: { notificationRoutingMode: "BELL_AND_EMAIL" },
        notificationPreferences: {
          allNotifications: true,
          inAppEnabled: true,
          paymentNotifications: false,
        },
      },
    ]);
    const txUpsert = jest.fn().mockImplementation(async (args) => ({
      id: "nx-staged-1",
      ...args.create,
    }));
    const tx = {
      user: { findMany: txFindMany },
      notificationOutbox: { upsert: txUpsert },
    } as never;

    const staged = await stageBell(tx, {
      workflowId: "payment-success",
      recipients: [
        "u_allowed_quiet",
        "u_email_only",
        "u_neither",
        "u_all_off",
        "u_inapp_off",
        "u_cat_muted",
      ],
      payload: { paymentId: "pay-99", dashboardUrl: "/dashboard" },
      dedupeKey: "pay-99",
      entityRef: "payment:pay-99",
    });

    expect(txFindMany).toHaveBeenCalledTimes(1);
    expect(txUpsert).toHaveBeenCalledTimes(1);
    expect(staged).not.toBeNull();
    expect(staged?.recipients).toEqual(["u_allowed_quiet"]);
    expect(staged?.kind).toBe("SINGLE");
    expect(staged?.notBefore).toBeInstanceOf(Date);
    expect((staged?.notBefore as Date).getTime()).toBeGreaterThan(Date.now());

    // When all recipients opt out, stageBell returns null without writing to NotificationOutbox
    txUpsert.mockClear();
    txFindMany.mockResolvedValueOnce([
      {
        id: "u_email_only",
        orgWorkspaceProfile: { notificationRoutingMode: "EMAIL_ONLY" },
      },
      {
        id: "u_neither",
        orgWorkspaceProfile: { notificationRoutingMode: "NEITHER" },
      },
      {
        id: "u_inapp_off",
        notificationPreferences: { inAppEnabled: false },
      },
    ]);

    const skipped = await stageBell(tx, {
      workflowId: "payment-success",
      recipients: ["u_email_only", "u_neither", "u_inapp_off"],
      payload: { paymentId: "pay-100", dashboardUrl: "/dashboard" },
      dedupeKey: "pay-100",
    });

    expect(skipped).toBeNull();
    expect(txUpsert).not.toHaveBeenCalled();
  });
});

describe("2. computeSubscriberHash(subscriberId) HMAC-SHA256 digest", () => {
  it("generates deterministic HMAC-SHA256 hex digest using the active NOVU_*_KEY", () => {
    delete process.env.NOVU_DEVELOPMENT_KEY;
    delete process.env.NOVU_PRODUCTION_KEY;
    expect(computeSubscriberHash("user_123")).toBeUndefined();

    process.env.NOVU_DEVELOPMENT_KEY = "sk_dev_hmac_test_key";
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "development";
    const expectedDev = createHmac("sha256", "sk_dev_hmac_test_key")
      .update("user_123")
      .digest("hex");

    expect(computeSubscriberHash("user_123")).toBe(expectedDev);
    expect(computeSubscriberHash("user_123")).toBe(expectedDev);
    expect(computeSubscriberHash("user_456")).not.toBe(expectedDev);

    process.env.NOVU_PRODUCTION_KEY = "sk_prod_hmac_test_key";
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";
    const expectedProd = createHmac("sha256", "sk_prod_hmac_test_key")
      .update("user_123")
      .digest("hex");

    expect(computeSubscriberHash("user_123")).toBe(expectedProd);
    expect(expectedProd).not.toBe(expectedDev);
  });
});

describe("3. buildSubscriberCustomData fail-closed DB read", () => {
  it("propagates DB failures rather than silently defaulting opted-out users back to masterEnabled: true", async () => {
    mockUserFindUnique.mockRejectedValueOnce(
      new Error("PgBouncer connection pool exhausted"),
    );

    await expect(
      buildSubscriberCustomData("user_opted_out", {}),
    ).rejects.toThrow("PgBouncer connection pool exhausted");
  });
});

describe("4. updateSubscriberPreferences idempotent upsert", () => {
  it("calls idempotent novu.subscribers.create(...) so unsynced users never 404", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      orgWorkspaceProfile: { notificationRoutingMode: "BELL_ONLY" },
      notificationPreferences: null,
    });
    mockSubscriberCreate.mockResolvedValueOnce({});

    await updateSubscriberPreferences("unsynced_user_7", {
      allNotifications: true,
      inApp: true,
      email: false,
      appointmentReminders: false,
    });

    expect(mockSubscriberCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriberCreate).toHaveBeenCalledWith({
      subscriberId: "unsynced_user_7",
      data: expect.objectContaining({
        routingMode: "BELL_ONLY",
        routingBell: true,
        routingEmail: false,
        masterEnabled: true,
        preferInApp: true,
        preferEmail: false,
        categoryAppointments: false,
      }),
    });
  });
});

describe("5. flushNotificationsAfter concurrent bundle dispatch & inline fallback", () => {
  it("flushes both bells and emails bundles concurrently and awaits inline when outside Next.js request context", async () => {
    const order: string[] = [];
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    mockAttemptTrigger.mockImplementation(async (row: StagedTrigger) => {
      order.push(`start:${row.id}`);
      await gate;
      if (row.id === "bell-fail") {
        throw new Error("Transient Novu 502");
      }
      order.push(`done:${row.id}`);
      return { success: true, outcome: "SENT" };
    });

    mockAttemptStaged.mockImplementation(
      async (_rows: unknown, emailType: string) => {
        order.push(`start:${emailType}`);
        await gate;
        order.push(`done:${emailType}`);
      },
    );

    const bellOk: StagedTrigger = {
      id: "bell-ok",
      workflowId: "appointment-booked",
      kind: "SINGLE",
      recipients: ["u1"],
      payload: { appointmentId: "appt-1" },
      transactionId: "appointment-booked:1",
      attempts: 0,
      status: "PENDING",
      notBefore: null,
    };
    const bellFail: StagedTrigger = {
      ...bellOk,
      id: "bell-fail",
      transactionId: "appointment-booked:2",
    };

    const flushPromise = flushNotificationsAfter(
      {
        bells: [bellOk, bellFail, null],
        emails: [
          {
            rows: [
              {
                staged: {
                  id: "fe-1",
                  idempotencyKey: "APPOINTMENT_BOOKED/failed-email/fe-1",
                },
                message: {
                  from: "Familiarise <notifications@mail.familiarisenow.com>",
                  to: "u1@example.com",
                  subject: "Booked",
                  html: "<p>Booked</p>",
                },
              },
            ],
            emailType: "APPOINTMENT_BOOKED",
            budgetMs: 3_000,
          },
        ],
      },
      "test-booking-flush",
    );

    // Drain microtasks (the email sender loads lazily): all 3 dispatches must start before the gate opens
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([
      "start:bell-ok",
      "start:bell-fail",
      "start:APPOINTMENT_BOOKED",
    ]);

    releaseAll();
    await flushPromise;

    expect(order).toContain("done:bell-ok");
    expect(order).toContain("done:APPOINTMENT_BOOKED");
    expect(mockAttemptStaged).toHaveBeenCalledWith(
      expect.any(Array),
      "APPOINTMENT_BOOKED",
      3_000,
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("attempts a bell staged twice under the same row id only once", async () => {
    mockAttemptTrigger.mockResolvedValue({ success: true, outcome: "SENT" });
    const row: StagedTrigger = {
      id: "bell-shared",
      workflowId: "appointment-booked",
      kind: "SINGLE",
      recipients: ["u1"],
      payload: { appointmentId: "appt-1" },
      transactionId: "appointment-booked:shared",
      attempts: 0,
      status: "PENDING",
      notBefore: null,
    };
    const other: StagedTrigger = {
      ...row,
      id: "bell-other",
      transactionId: "appointment-booked:other",
    };

    await flushNotificationsAfter(
      { bells: [row, { ...row }, other, null, row] },
      "test-dedupe-flush",
    );

    expect(mockAttemptTrigger.mock.calls.map(([r]) => r.id)).toEqual([
      "bell-shared",
      "bell-other",
    ]);
  });
});
