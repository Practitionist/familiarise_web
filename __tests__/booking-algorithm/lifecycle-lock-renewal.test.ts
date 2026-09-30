/**
 * A lifecycle mutation's retry loop must not outlive its lock.
 *
 * `withAppointmentLock` grants `APPOINTMENT_LOCK_TTL_MS` (75 s) once. Two
 * callers wrap `withSerializableRetry` — four attempts — AROUND that grant
 * without renewing it:
 *
 * - `lib/booking/abandon.ts`: 4 × (10 s maxWait + 15 s timeout) ≈ 100 s
 * - `lib/booking/lapse-approved-request.ts`: 4 × (10 s + 30 s) ≈ 160 s
 *
 * So the grant can lapse mid-run and a second writer can take the key. The
 * damage is bounded and this file says exactly how: every CAS in both bodies
 * carries its state (and money) predicate in the UPDATE's WHERE, so the second
 * writer matches zero rows and answers with its own typed refusal. What lapsing
 * costs is the SERIALISATION, which is the whole reason the coarsest key exists.
 *
 * Both now re-grant per attempt, the shape the approval path already uses
 * through `renewApprovalLock` (#1319).
 */

import fs from "fs";
import path from "path";

import "./setup";

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    // The withdrawal's ownership read, and the CAS body. `updateMany` matching
    // zero rows is the honest answer here — the request is not
    // APPROVED_PENDING_PAYMENT — and it is exactly what makes the pin below
    // about the RENEWAL rather than about a successful withdrawal.
    consultation: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointmentOccurrence: {
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

const lockRenewals: unknown[] = [];
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: async (
    id: string,
    fn: (lock: unknown) => Promise<unknown>,
  ) => fn({ key: `appointment-lock:${id}` }),
  renewAppointmentLock: jest.fn(async (lock: unknown) => {
    lockRenewals.push(lock);
    return true;
  }),
}));

jest.mock("../../scripts/payments/cleanup-abandoned-payments", () => ({
  cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
}));

import { abandonBooking } from "@/lib/booking/abandon";
import { withdrawApproval } from "@/lib/booking/lapse-approved-request";
import prisma from "@/lib/prisma";

const db = prisma as unknown as {
  appointment: { findFirst: jest.Mock; findUnique: jest.Mock };
  consultation: { findUnique: jest.Mock };
};

const CONSULTATION_ROW = {
  id: "consult-1",
  status: "APPROVED_PENDING_PAYMENT",
  consultationPlan: { consultantProfileId: "cp-1" },
  requestedBy: { user: { id: "buyer-1", name: "Buyer" } },
  appointment: {
    id: "appt-1",
    organizationId: null,
    occurrences: [{ startsAt: new Date("2026-09-24T09:00:00Z") }],
  },
};

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

beforeEach(() => {
  jest.clearAllMocks();
  lockRenewals.length = 0;
  db.appointment.findUnique.mockResolvedValue(null);
  db.appointment.findFirst.mockResolvedValue(null);
  db.consultation.findUnique.mockResolvedValue(CONSULTATION_ROW);
});

describe("abandon re-grants the appointment lock on every attempt", () => {
  it("renews INSIDE the retry loop, not once around it", () => {
    // The shape is the whole pin: a renewal taken before the retry wrapper
    // opens happens exactly once, which is the bug. The paren matters — the
    // IMPORT of withSerializableRetry sits near the top of the file.
    const src = read("lib/booking/abandon.ts");
    const retryCall = src.indexOf("withSerializableRetry(");
    const renewCall = src.indexOf("renewAppointmentLock(lock)");
    expect(retryCall).toBeGreaterThan(-1);
    expect(renewCall).toBeGreaterThan(retryCall);
  });

  it("calls the renewal with the grant the lock handed it", async () => {
    // Executed through `withAppointmentLock`'s own shape: the mock hands the
    // grant to the callback exactly as the real wrapper does, so a caller that
    // stopped threading it through would be visible here.
    db.appointment.findUnique.mockResolvedValue({
      id: "appt-1",
      deletedAt: null,
      organizationId: null,
      consultation: { id: "consult-1", requestedBy: { userId: "buyer-1" } },
      subscription: null,
      trial: null,
      webinar: null,
      class: null,
    });
    db.consultation.findUnique.mockResolvedValue({
      ...CONSULTATION_ROW,
      // The CAS pre-read the transition helper takes.
      status: "PENDING",
    });

    // Whatever this answers (the CAS body is not what is under test here, and a
    // refusal is a perfectly good outcome), the renewal is the first statement
    // of the attempt and must have run.
    await abandonBooking({
      appointmentId: "appt-1",
      userId: "buyer-1",
    }).catch(() => undefined);

    expect(lockRenewals).toEqual([{ key: "appointment-lock:appt-1" }]);
  });
});

describe("withdrawApproval re-grants it too", () => {
  it("takes the renewal as a required argument, beside the lock", () => {
    // Required rather than defaulted: a defaulted renewal is a renewal somebody
    // can forget, and this retry loop is 4 × 40 s against a 75 s grant.
    const src = read("lib/booking/lapse-approved-request.ts");
    expect(src).toContain("renewLock: RenewInjectedLock;");
    expect(src).not.toContain("renewLock?: RenewInjectedLock");
    // Inside the retry wrapper, not once around it.
    expect(src.indexOf("await args.renewLock(lock);")).toBeGreaterThan(
      src.indexOf("withSerializableRetry("),
    );
  });

  it("calls it once per attempt, with the grant the lock handed over", async () => {
    const renewLock = jest.fn().mockResolvedValue(undefined);

    // The renewal is the first statement of the attempt, so it fires even
    // though the CAS below then refuses (this request is not
    // APPROVED_PENDING_PAYMENT at write time) and the route answers 409.
    await withdrawApproval({
      kind: "consultation",
      id: "consult-1",
      actor: {
        userId: "consultant-1",
        consultantProfileId: "cp-1",
        privileged: false,
      },
      lock: async (_id, fn) => fn({ key: "appointment-lock:appt-1" }),
      renewLock,
    }).catch(() => undefined);

    expect(renewLock).toHaveBeenCalledWith({ key: "appointment-lock:appt-1" });
  });

  it("does not take the Redis module's dependency back", () => {
    // The sweeps import `lapseApprovedRequest` from this file, which is why the
    // lock is injected at all: the Redis client does not load under jsdom.
    const src = read("lib/booking/lapse-approved-request.ts");
    expect(src).not.toContain('from "@/utils/appointmentlock"');
  });
});

describe("the grant the renewal re-issues", () => {
  it("defaults to the appointment lock's own TTL", () => {
    const src = read("utils/appointmentlock.ts");
    expect(src).toContain(
      "export async function renewAppointmentLock(",
    );
    expect(src).toContain("ttl: number = APPOINTMENT_LOCK_TTL_MS");
  });

  it("never throws, because the CAS — not the lock — decides the write", () => {
    // A lapsed grant means somebody else holds the key. Throwing would replace
    // the caller's clean typed refusal (NOT_ABANDONABLE / ALREADY_PAID /
    // REQUEST_CHANGED_ELSEWHERE) with a lock error none of them has a code for.
    const src = read("utils/appointmentlock.ts");
    const start = src.indexOf("export async function renewAppointmentLock(");
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toContain("if (!lock) return false;");
    expect(body).toContain("return await extendLock(lock, ttl);");
    expect(body).not.toContain("throw");
  });
});
