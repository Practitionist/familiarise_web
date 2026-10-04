/**
 * @jest-environment node
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

import { resolveBookingRefundContext } from "../../lib/booking/cancellation-scope";
import { stampTranchesOnCancel } from "../../lib/booking/subscription-cycle";
import {
  softCancelTrialAppointmentInTx,
  stampTrialEarningsOnCancel,
} from "../../lib/trials/cancellation";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findFirst: jest.fn(),
    },
    appointmentOccurrence: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));

import prisma from "../../lib/prisma";

function loadCronTicker(): {
  buildFailedTargetEvent: (failed: {
    name: string;
    status: number;
    errorBody?: string;
  }) => {
    message: string;
    contexts: { tick: Record<string, unknown> };
  };
} {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "netlify",
    "functions",
    "cron-tick.mts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = { exports: {} as ReturnType<typeof loadCronTicker> };
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports });
  return mod.exports;
}

describe("Area 4 — Lifecycle & Money Spine Fixes (F-4.1 through F-4.17)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("F-4.12 (User Decision A1) — Reschedule notice floor prevents cancellation tier laundering", () => {
    it("clamps hoursUntilNextSession to the minimum notice from a tombstoned rescheduled occurrence", async () => {
      const nowMs = Date.now();
      const rescheduleMoment = new Date(nowMs - 22 * 60 * 60 * 1000);
      // Tombstoned slot started 6 hours after the reschedule moment
      const tombstonedStart = new Date(
        rescheduleMoment.getTime() + 6 * 60 * 60 * 1000,
      );
      // New rescheduled slot starts 5 days (120 hours) in the future
      const futureStart = new Date(nowMs + 120 * 60 * 60 * 1000);
      const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);

      (prisma.appointment.findFirst as jest.Mock).mockResolvedValueOnce({
        id: "apt-1",
        cancellationPolicy: null,
        payment: [
          {
            id: "pay-1",
            amount: 10000,
            paymentIntent: "pay_123",
            refunds: [],
            disputes: [],
          },
        ],
        occurrences: [
          {
            startsAt: futureStart,
            endsAt: futureEnd,
            completionStatus: "SCHEDULED",
            isTentative: false,
            updatedAt: rescheduleMoment,
            deletedAt: null,
          },
        ],
        subscription: null,
      });

      (
        prisma.appointmentOccurrence.findMany as jest.Mock
      ).mockResolvedValueOnce([
        {
          startsAt: tombstonedStart,
          updatedAt: rescheduleMoment,
          deletedAt: rescheduleMoment,
          completionStatus: "RESCHEDULED",
        },
      ]);

      const ctx = await resolveBookingRefundContext(
        { consultationId: "cons-1" },
        undefined,
        prisma as never,
      );

      // Without clamping, hoursUntilNextSession would be ~120 hours (5 days).
      // With the reschedule notice floor, it is clamped to 6 hours.
      expect(ctx.hoursUntilNextSession).toBe(6);
    });
  });

  describe("F-4.8 — Trial soft-cancel releases occurrences and stampTrialEarningsOnCancel stamps holdUntil", () => {
    it("releases trial occurrences in softCancelTrialAppointmentInTx and stamps holdUntil on both consultantEarnings and organizationEarnings in stampTrialEarningsOnCancel", async () => {
      const tx = {
        appointmentOccurrence: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "occ-1",
              completionStatus: "SCHEDULED",
              startsAt: new Date("2026-06-12T10:00:00.000Z"),
              endsAt: new Date("2026-06-12T10:30:00.000Z"),
            },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          updateManyAndReturn: jest
            .fn()
            .mockResolvedValue([{ id: "occ-1", appointmentId: "apt-trial-1" }]),
        },
        bookingStatusHistory: {
          create: jest.fn().mockResolvedValue({ id: "hist-1" }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        appointment: {
          update: jest.fn().mockResolvedValue({ id: "apt-trial-1" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        appointmentParticipant: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          updateManyAndReturn: jest.fn().mockResolvedValue([]),
        },
        consultantEarnings: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
        organizationEarnings: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      };

      const released = await softCancelTrialAppointmentInTx(
        tx as never,
        "apt-trial-1",
      );
      expect(released).toBe(1);

      const stamped = await stampTrialEarningsOnCancel(tx as never, {
        appointmentId: "apt-trial-1",
      });
      expect(stamped).toBe(1);
      expect(tx.consultantEarnings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            holdUntil: null,
            payment: { appointmentId: "apt-trial-1" },
          }),
          data: { holdUntil: expect.any(Date) },
        }),
      );
      expect(tx.organizationEarnings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            holdUntil: null,
            payment: { appointmentId: "apt-trial-1" },
          }),
          data: { holdUntil: expect.any(Date) },
        }),
      );

      // Idempotent second call when holdUntil is already non-null
      const secondStamped = await stampTrialEarningsOnCancel(tx as never, {
        appointmentId: "apt-trial-1",
      });
      expect(secondStamped).toBe(0);
    });
  });

  describe("F-4.9 & F-4.13 (User Decision A4) — Subscription cancellation stamps both consultant & organization earnings", () => {
    it("stamps holdUntil on remaining unstamped consultant tranches and organization earnings and is idempotent on repeat calls", async () => {
      const now = new Date("2026-06-10T10:00:00.000Z");
      const tx = {
        consultantEarnings: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 2 })
            .mockResolvedValueOnce({ count: 0 }),
        },
        organizationEarnings: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 }),
        },
      };

      const count = await stampTranchesOnCancel(tx as never, {
        paymentId: "pay-sub-1",
        now,
      });

      expect(count).toBe(2);
      expect(tx.consultantEarnings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            paymentId: "pay-sub-1",
            cycleOrdinal: { not: null },
            holdUntil: null,
          }),
          data: { holdUntil: expect.any(Date) },
        }),
      );
      expect(tx.organizationEarnings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            paymentId: "pay-sub-1",
            holdUntil: null,
          }),
          data: { holdUntil: expect.any(Date) },
        }),
      );

      // Second call is a no-op once holdUntil is already stamped
      const secondCount = await stampTranchesOnCancel(tx as never, {
        paymentId: "pay-sub-1",
        now,
      });
      expect(secondCount).toBe(0);
    });
  });

  describe("F-4.17 — Cron ticker captures non-2xx error body in Sentry failed target event", () => {
    it("attaches errorBody to contexts.tick when present", () => {
      const { buildFailedTargetEvent } = loadCronTicker();
      const event = buildFailedTargetEvent({
        name: "reconcile-pending-refunds",
        status: 500,
        errorBody: '{"error":"Serializable conflict exhausted"}',
      });

      expect(event.contexts.tick).toEqual({
        target: "reconcile-pending-refunds",
        status: 500,
        outcome: "http",
        errorBody: '{"error":"Serializable conflict exhausted"}',
      });
    });
  });
});
