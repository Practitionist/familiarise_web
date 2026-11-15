/**
 * Required notices on real Postgres: the SQL twin (`bellAudience`) and the
 * per-recipient rule agree with the override on; a recipient with every
 * switch off still gets each required kind's bell (through the first-attempt
 * recheck) and email; the same send without the override reaches no one
 * muted; and an erased user receives neither.
 */
import { randomUUID } from "node:crypto";

const mockTrigger = jest.fn();
jest.mock("../../lib/novu/client", () => ({
  __esModule: true,
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...args),
    triggerBulk: jest.fn(),
  }),
}));

// react-email's renderer needs ESM dynamic import, which this tier's VM lacks; the row is what is pinned.
jest.mock("../../lib/email/render", () => {
  const { renderToStaticMarkup } =
    jest.requireActual<typeof import("react-dom/server")>("react-dom/server");
  return {
    renderEmail: async (element: import("react").ReactElement) => {
      const html = renderToStaticMarkup(element);
      return { html, text: html };
    },
  };
});

import prisma from "../../lib/prisma";
import { NOVU_WORKFLOWS, notificationScope } from "../../lib/novu/workflows";
import { bellAudience, currentBellRecipients } from "../../lib/novu/policy";
import { attemptTrigger, type StagedTrigger } from "../../lib/novu/outbox";
import { stageBell } from "../../lib/novu/stage-bell";
import {
  notifyAppointmentCancelled,
  notifyAppointmentRescheduled,
  notifyRefundProcessed,
} from "../../lib/novu/service";
import {
  stageAppointmentCancelledEmail,
  stageAppointmentRescheduledEmail,
} from "../../lib/email/senders/booking";
import { stageRefundProcessedEmail } from "../../lib/email/senders/money";
import {
  REQUIRED_NOTICE_KINDS,
  type RequiredNoticeKind,
} from "../../lib/notifications/required-notices";

const MUTED = {
  allNotifications: false,
  inAppEnabled: false,
  emailEnabled: false,
  appointmentReminders: false,
  paymentNotifications: false,
};

async function seedUser(
  opts: { muted?: boolean; erased?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      name: "Required tier",
      email: `${id}@example.test`,
      emailVerified: true,
      erasedAt: opts.erased ? new Date() : null,
      ...(opts.muted ? { notificationPreferences: { create: MUTED } } : {}),
    },
  });
  return id;
}

const APPOINTMENT = {
  ...notificationScope(null),
  appointmentType: "CONSULTATION",
  consultantName: "Expert",
  consulteeName: "Buyer",
  planTitle: "Plan",
  dashboardUrl: "/dashboard",
};

/** Stages the kind's real bell and email for `userId`, with or without the override. */
async function stageKind(
  kind: RequiredNoticeKind,
  userId: string,
  required: boolean,
): Promise<{ bells: StagedTrigger[]; entityRef: string }> {
  const override = required ? { kind, recipients: [userId] } : undefined;
  const appointmentId = randomUUID();
  const entityRef = `appointment:${appointmentId}`;
  const opts = { deferAttempt: true, required: override };
  if (
    kind === "REFUND_FROM_HOST_CANCEL" ||
    kind === "REFUND_FROM_STAFF_CANCEL"
  ) {
    const paymentId = randomUUID();
    const bell = await notifyRefundProcessed(
      userId,
      {
        ...notificationScope(null),
        amount: 50_000,
        currency: "INR",
        dashboardUrl: "/dashboard",
      },
      opts,
    );
    await stageRefundProcessedEmail(prisma, {
      userId,
      paymentId,
      amountPaise: 50_000,
      currency: "INR",
      required,
    });
    return {
      bells: bell.staged ? [bell.staged] : [],
      entityRef: `payment:${paymentId}`,
    };
  }
  if (kind === "CLASS_SESSION_REFUNDED") {
    const bell = await stageBell(prisma, {
      workflowId: NOVU_WORKFLOWS.CLASS_SESSION_REFUNDED,
      recipients: [userId],
      payload: {
        planTitle: "Plan",
        amount: "₹500",
        dashboardUrl: "/dashboard",
      },
      dedupeKey: `occ-refund:${appointmentId}`,
      ...(required ? { required: kind } : {}),
    });
    await stageAppointmentCancelledEmail(prisma, {
      appointmentId,
      userIds: [userId],
      cancelledBy: "Familiarise",
      dashboardUrl: "/dashboard",
      ...(required ? { requiredFor: [userId] } : {}),
    });
    return { bells: bell ? [bell] : [], entityRef };
  }
  if (
    kind === "CANCELLED_BY_HOST" ||
    kind === "CANCELLED_BY_STAFF" ||
    kind === "SEAT_RELEASED"
  ) {
    const bells = await notifyAppointmentCancelled(
      [userId],
      { ...APPOINTMENT, appointmentId, cancelledBy: "consultant" },
      opts,
    );
    await stageAppointmentCancelledEmail(prisma, {
      appointmentId,
      userIds: [userId],
      cancelledBy: "Expert",
      dashboardUrl: "/dashboard",
      ...(required ? { requiredFor: [userId] } : {}),
    });
    return { bells: bells.flatMap((r) => r.staged ?? []), entityRef };
  }
  const outcome =
    kind === "RESCHEDULE_PROPOSED"
      ? "PROPOSED"
      : kind === "SERIES_MOVED" ||
          kind === "EVENT_MOVED" ||
          kind === "MOVE_AUTO_CONFIRMED"
        ? "MOVED"
        : kind === "REQUEST_DECLINED"
          ? "DECLINED"
          : "EXPIRED";
  const bells = await notifyAppointmentRescheduled(
    [userId],
    outcome === "EXPIRED" || outcome === "DECLINED"
      ? { ...APPOINTMENT, outcome }
      : {
          ...APPOINTMENT,
          outcome,
          oldDateTime: "2026-12-01T04:30:00.000Z",
          newDateTime: "2026-12-02T04:30:00.000Z",
        },
    opts,
  );
  await stageAppointmentRescheduledEmail(prisma, {
    appointmentId,
    userIds: [userId],
    outcome,
    appointmentType: "CONSULTATION",
    dashboardUrl: "/dashboard",
    ...(required ? { requiredFor: [userId] } : {}),
  });
  return { bells: bells.flatMap((r) => r.staged ?? []), entityRef };
}

describe("the SQL twin agrees with the per-recipient rule under the override", () => {
  const ids: string[] = [];
  beforeAll(async () => {
    ids.push(
      await seedUser(),
      await seedUser({ muted: true }),
      await seedUser({ erased: true }),
    );
  });

  it.each([
    NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
    NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED,
    NOVU_WORKFLOWS.REFUND_PROCESSED,
  ])("%s", async (workflowId) => {
    const seeded = new Set(ids);
    const sql = (
      (await bellAudience(prisma, workflowId, 1_000_000, { required: true })) ??
      []
    ).filter((id) => seeded.has(id));
    const js = await currentBellRecipients(workflowId, ids, {
      required: true,
    });
    expect(sql.sort()).toEqual(js.sort());
    expect(js.sort()).toEqual([ids[0], ids[1]].sort());
    const gated = await currentBellRecipients(workflowId, ids);
    expect(gated).toEqual([ids[0]]);
  });
});

describe("each required kind reaches a recipient with every switch off", () => {
  beforeEach(() => {
    mockTrigger.mockReset();
    mockTrigger.mockResolvedValue({ result: { status: "processed" } });
  });

  it.each(REQUIRED_NOTICE_KINDS)("%s", async (kind) => {
    const muted = await seedUser({ muted: true });
    const { bells, entityRef } = await stageKind(kind, muted, true);

    expect(bells).toHaveLength(1);
    await attemptTrigger(bells[0], { suppressSentry: true });
    expect(mockTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ to: muted }),
      expect.any(String),
    );
    const emails = await prisma.failedEmail.findMany({
      where: { entityRef, deliveryUserId: muted },
      select: { deliveryCategory: true },
    });
    expect(emails).toEqual([{ deliveryCategory: null }]);
  });

  it.each(REQUIRED_NOTICE_KINDS)(
    "%s without the override stays behind the switches",
    async (kind) => {
      const muted = await seedUser({ muted: true });
      const { bells, entityRef } = await stageKind(kind, muted, false);
      expect(bells).toHaveLength(0);
      expect(
        await prisma.failedEmail.count({
          where: { entityRef, deliveryUserId: muted },
        }),
      ).toBe(0);
    },
  );

  it("an erased user receives neither, required or not", async () => {
    const erased = await seedUser({ erased: true });
    const { bells, entityRef } = await stageKind(
      "CANCELLED_BY_HOST",
      erased,
      true,
    );
    expect(bells).toHaveLength(0);
    expect(await prisma.failedEmail.count({ where: { entityRef } })).toBe(0);
  });
});
