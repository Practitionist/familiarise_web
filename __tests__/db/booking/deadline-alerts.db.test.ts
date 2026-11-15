/**
 * The expert's deadline alerts on real Postgres, as arms of the stale-request
 * sweep: a request six hours from lapsing rings one bell and stages one email
 * however often the sweep runs, an expert with every switch off gets neither,
 * and the hour-36 unplaced-plan nudge names the 48-hour refund time.
 */
const mockTrigger = jest.fn(async () => ({ result: { status: "processed" } }));
jest.mock("../../../lib/novu/client", () => ({
  __esModule: true,
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...(args as [])),
    triggerBulk: jest.fn(),
  }),
}));
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  ...jest.requireActual("../../../lib/cron/with-cron-lock"),
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));

// react-email's renderer needs ESM dynamic import, which this tier's VM lacks; the row is what is pinned.
jest.mock("../../../lib/email/render", () => {
  const { renderToStaticMarkup } =
    jest.requireActual<typeof import("react-dom/server")>("react-dom/server");
  return {
    renderEmail: async (element: import("react").ReactElement) => {
      const html = renderToStaticMarkup(element);
      return { html, text: html };
    },
  };
});

import prisma from "../../../lib/prisma";
import { NOVU_WORKFLOWS } from "../../../lib/novu/workflows";
import { deriveTransactionId } from "../../../lib/novu/outbox";
import {
  REQUEST_EXPIRING_EMAIL_TYPE,
  requestExpiringEntityRef,
} from "../../../lib/email/senders/booking";
import {
  expireStaleRequests,
  requestExpiringDedupeKey,
  subscriptionNudgeDedupeKey,
} from "../../../scripts/appointments/expire-stale-requests";
import {
  HOUR_MS,
  futureAt,
  seedConsultee,
  seedHost,
  seedOneToOne,
  seedPaidSubscription,
} from "./harness";

/** A submitted request `hoursAgo` old, waiting on `host`. */
async function seedRequest(hoursAgo: number, muted = false) {
  const host = await seedHost();
  if (muted) {
    await prisma.notificationPreference.create({
      data: {
        userId: host.userId,
        allNotifications: false,
        inAppEnabled: false,
        emailEnabled: false,
        appointmentReminders: false,
      },
    });
  }
  const consultee = await seedConsultee();
  const seeded = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt: futureAt(5, 6), endsAt: futureAt(5, 7) },
    {
      status: "PENDING",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
    },
  );
  const consultationId = seeded.consultationId ?? "";
  await prisma.consultation.update({
    where: { id: consultationId },
    data: { requestedAt: new Date(Date.now() - hoursAgo * HOUR_MS) },
  });
  return { host, consultationId };
}

async function alertRows(hostUserId: string, consultationId: string) {
  const transactionId = deriveTransactionId(
    NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
    [hostUserId],
    {},
    requestExpiringDedupeKey(consultationId),
  );
  const [bells, emails] = await Promise.all([
    prisma.notificationOutbox.findMany({
      where: { transactionId },
      select: { payload: true },
    }),
    prisma.failedEmail.count({
      where: {
        emailType: REQUEST_EXPIRING_EMAIL_TYPE,
        entityRef: requestExpiringEntityRef(consultationId),
      },
    }),
  ]);
  return { bells, emails };
}

describe("request about to lapse", () => {
  it("alerts the expert once, six hours before the hold ends", async () => {
    const due = await seedRequest(43);
    const early = await seedRequest(30);

    await expireStaleRequests();
    await expireStaleRequests();

    const alerted = await alertRows(due.host.userId, due.consultationId);
    expect(alerted.bells).toHaveLength(1);
    expect(alerted.emails).toBe(1);
    expect(alerted.bells[0].payload).toMatchObject({
      expiresAtIso: expect.any(String),
    });
    const quiet = await alertRows(early.host.userId, early.consultationId);
    expect(quiet).toEqual({ bells: [], emails: 0 });
  });

  it("follows the expert's switches", async () => {
    const muted = await seedRequest(43, true);
    await expireStaleRequests();
    expect(await alertRows(muted.host.userId, muted.consultationId)).toEqual({
      bells: [],
      emails: 0,
    });
  });
});

describe("paid plan still unplaced at hour 36", () => {
  it("names the time the buyer is refunded", async () => {
    const host = await seedHost();
    const subscriber = await seedConsultee();
    const sub = await seedPaidSubscription(host, subscriber, futureAt(3, 6));
    const paidAt = new Date(Date.now() - 37 * HOUR_MS);
    await prisma.payment.updateMany({
      where: { appointmentId: sub.appointmentId },
      data: { capturedAt: paidAt },
    });

    await expireStaleRequests();

    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        transactionId: deriveTransactionId(
          NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
          [host.userId],
          {},
          subscriptionNudgeDedupeKey(sub.subscriptionId, 36),
        ),
      },
      select: { payload: true },
    });
    expect(row.payload).toMatchObject({
      nudgeHours: 36,
      refundAtIso: new Date(paidAt.getTime() + 48 * HOUR_MS).toISOString(),
    });
  });
});
