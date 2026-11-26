/**
 * @jest-environment node
 */

/**
 * A notifier keeps its options when the dedupe key is left out: a trigger
 * staged inside a transaction reads and writes only through that transaction,
 * and a deferred trigger is staged without an inline attempt.
 */

const mockGlobalUserFindMany = jest.fn();
const mockGlobalUpsert = jest.fn();
const mockAttempt = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockGlobalUserFindMany(...args) },
    notificationOutbox: {
      upsert: (...args: unknown[]) => mockGlobalUpsert(...args),
    },
    $transaction: () => {
      throw new Error("global client used");
    },
  },
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => {
    throw new Error("Novu called inline");
  },
}));
jest.mock("../../lib/novu/outbox", () => ({
  ...jest.requireActual("../../lib/novu/outbox"),
  attemptTrigger: (...args: unknown[]) => mockAttempt(...args),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import type { TriggerOptions } from "@/lib/novu/service";
import {
  notifyAppointmentBooked,
  notifySubscriptionStarted,
} from "@/lib/novu/service";

type Tx = NonNullable<TriggerOptions["tx"]>;

const USERS = [
  {
    id: "u1",
    timezone: "Asia/Kolkata",
    erasedAt: null,
    notificationPreferences: null,
  },
  {
    id: "u2",
    timezone: "Asia/Kolkata",
    erasedAt: null,
    notificationPreferences: null,
  },
];

const payload = {
  organizationId: null,
  scope: "personal" as const,
  appointmentId: "appt-1",
  dateTime: "2026-12-01T10:00:00.000Z",
  appointmentType: "CONSULTATION",
  consultantName: "Arjun",
  consulteeName: "Riya",
  planTitle: "Intro call",
  dashboardUrl: "/dashboard/appointments",
};

function globalClientUsed(): never {
  throw new Error("global client used");
}

function fakeTx() {
  const userFindMany = jest.fn(async () => USERS);
  const upsert = jest.fn(async (q: { where: { transactionId: string } }) => ({
    id: `nx-${q.where.transactionId}`,
    status: "PENDING",
  }));
  const tx = {
    user: { findMany: userFindMany },
    notificationOutbox: { upsert },
    membership: {},
  } as unknown as Tx;
  return { tx, userFindMany, upsert };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGlobalUserFindMany.mockImplementation(globalClientUsed);
  mockGlobalUpsert.mockImplementation(globalClientUsed);
});

describe("notifier options forwarding", () => {
  it("stages through tx when the dedupe key is undefined", async () => {
    const { tx, userFindMany, upsert } = fakeTx();

    const results = await notifyAppointmentBooked(
      ["u1", "u2"],
      payload,
      undefined,
      { tx },
    );

    expect(mockGlobalUserFindMany).not.toHaveBeenCalled();
    expect(mockGlobalUpsert).not.toHaveBeenCalled();
    // One read for the zones, one for the bell policy, one staged MULTI row.
    expect(userFindMany).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.staged?.id).toMatch(/^nx-/);
    expect(mockAttempt).not.toHaveBeenCalled();
  });

  it("keys the row the same whether the key is the third argument or in the options", async () => {
    const positional = fakeTx();
    const inOptions = fakeTx();
    const unkeyed = fakeTx();

    await notifyAppointmentBooked(["u1", "u2"], payload, "key", {
      tx: positional.tx,
    });
    await notifyAppointmentBooked(["u1", "u2"], payload, {
      tx: inOptions.tx,
      dedupeKey: "key",
    });
    await notifyAppointmentBooked(["u1", "u2"], payload, undefined, {
      tx: unkeyed.tx,
    });

    const keyOf = (u: jest.Mock) =>
      (u.mock.calls[0][0] as { where: { transactionId: string } }).where
        .transactionId;
    expect(keyOf(positional.upsert)).toBe(keyOf(inOptions.upsert));
    expect(keyOf(unkeyed.upsert)).not.toBe(keyOf(positional.upsert));
    expect(mockGlobalUserFindMany).not.toHaveBeenCalled();
    expect(mockGlobalUpsert).not.toHaveBeenCalled();
  });

  it("stages a deferred trigger without an inline attempt when the key is undefined", async () => {
    mockGlobalUserFindMany.mockResolvedValue(USERS);
    mockGlobalUpsert.mockResolvedValue({ id: "nx-1", status: "PENDING" });

    const result = await notifySubscriptionStarted(
      "u1",
      {
        subscriptionId: "sub-1",
        planTitle: "Weekly",
        consultantName: "Arjun",
        dashboardUrl: "/dashboard/appointments",
      },
      undefined,
      { deferAttempt: true },
    );

    expect(mockGlobalUpsert).toHaveBeenCalledTimes(1);
    expect(mockAttempt).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      staged: { id: "nx-1", status: "PENDING" },
    });
  });
});
