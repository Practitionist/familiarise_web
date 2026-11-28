/**
 * @jest-environment node
 */

// Invariant: a negative verdict is written only together with its notices. When
// an eligible recipient's email fails to render, the slot pass defers: no
// verdict, no outcomeAt, so no report window; the next pass writes both.

const transition = jest.fn(async (..._a: unknown[]) => 1);
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: (...a: unknown[]) => transition(...a),
}));
jest.mock("../../lib/meetings/settle-attendance", () => ({
  ...jest.requireActual("../../lib/meetings/settle-attendance"),
  settleOccurrenceAttendance: jest.fn(async () => ({
    kind: "settled",
    // The host leaves at 30 of 60 minutes: a cut-short session.
    intervals: [
      { userId: "host", joinedAt: at(0), leftAt: at(30) },
      { userId: "learner", joinedAt: at(0), leftAt: at(60) },
    ],
  })),
}));
// The learner reads email only: in-app is off, so no bell would reach them.
jest.mock("../../lib/novu/policy", () => ({
  bellRecipientZones: jest.fn(async () => new Map()),
}));
jest.mock("../../lib/email/preferences", () => ({
  loadEmailRecipients: jest.fn(async () => [
    {
      userId: "learner",
      category: "appointments",
      email: "learner@example.com",
      name: "Asha",
      zone: "Asia/Kolkata",
      allowed: true,
      unsubscribeUrl: null,
    },
  ]),
}));
const renderEmail = jest.fn(async (..._a: unknown[]) => ({
  html: "<p>notice</p>",
  text: "notice",
}));
jest.mock("../../lib/email/render", () => ({
  renderEmail: (...a: unknown[]) => renderEmail(...a),
}));
const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  ...jest.requireActual("@sentry/nextjs"),
  captureException: (...a: unknown[]) => captureException(...a),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
const emailRows = jest.fn(async ({ data }: { data: { recipient: string }[] }) =>
  data.map((row, i) => ({ id: `fe-${i}`, recipient: row.recipient })),
);
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    appointment: { findUnique: jest.fn(async () => PARTIES) },
    user: { findMany: jest.fn(async () => []) },
    recording: { count: jest.fn(async () => 0) },
    meeting: {
      findUnique: jest.fn(async () => ({
        endedAt: at(60),
        endedReason: "call_ended",
        streamCallId: "c",
        attendanceSettledAt: null,
      })),
    },
    appointmentParticipant: { updateMany: jest.fn(async () => ({ count: 0 })) },
    notificationOutbox: { createManyAndReturn: jest.fn(async () => []) },
    failedEmail: {
      createManyAndReturn: (...a: unknown[]) =>
        emailRows(...(a as [{ data: { recipient: string }[] }])),
    },
    emailSuppression: { findMany: jest.fn(async () => []) },
  };
  client.$executeRaw = jest.fn(async () => 1);
  client.$queryRaw = jest.fn(async () => [
    {
      endedAt: at(60),
      endedReason: "call_ended",
      streamCallId: "c",
      settledAt: null,
    },
  ]);
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import {
  decideSlotOutcome,
  type OutcomeSlot,
} from "../../lib/booking/session-outcome-sweep";

function at(m: number) {
  return new Date(Date.UTC(2026, 10, 23, 10, 0) + m * 60_000);
}

const PARTIES = {
  organizationId: null,
  consultation: null,
  subscription: {
    subscriptionPlan: {
      title: "Weekly mentoring",
      recordingEnabled: false,
      consultantProfile: { userId: "host" },
    },
  },
  trial: null,
  webinar: null,
  class: null,
  participants: [
    {
      userId: "learner",
      status: "CONFIRMED",
      createdAt: new Date("2026-11-01T09:00:00Z"),
      paymentId: null,
    },
  ],
  payment: [],
};

const slot = {
  id: "occ-1",
  appointmentId: "apt-1",
  startsAt: at(0),
  endsAt: at(60),
  meeting: {
    id: "m-1",
    streamCallId: "c",
    extendedSeconds: 0,
    attendanceSettledAt: null,
    endedAt: at(60),
    endedReason: "call_ended",
  },
  appointment: {
    organizationId: null,
    subscriptionId: "sub-1",
    consultationId: null,
    classId: null,
    webinarId: null,
    subscription: {
      subscriptionPlan: { consultantProfile: { userId: "host" } },
    },
  },
} as unknown as OutcomeSlot;

it("an email-only learner's failed render defers the verdict, and the retry writes the verdict with that learner's email row", async () => {
  const failures = { add: jest.fn(), flush: jest.fn() };
  renderEmail.mockRejectedValueOnce(new Error("template threw"));

  const first = await decideSlotOutcome(slot, {
    now: at(120),
    outages: [],
    failures,
  });
  expect(first).toEqual({ kind: "deferred", reason: "notices-unprepared" });
  expect(transition).not.toHaveBeenCalled();
  expect(emailRows).not.toHaveBeenCalled();
  // Reported once through the run's reporter, never per row to Sentry.
  expect(failures.add).toHaveBeenCalledTimes(1);
  expect(captureException).not.toHaveBeenCalled();

  const next = await decideSlotOutcome(slot, {
    now: at(130),
    outages: [],
    failures,
  });
  expect(next).toMatchObject({ kind: "written", to: "VOIDED", moved: true });
  expect(transition).toHaveBeenCalledTimes(1);
  expect(transition.mock.calls[0][1]).toMatchObject({
    data: { outcome: "CUT_SHORT", outcomeAt: at(130) },
  });
  expect(emailRows).toHaveBeenCalledTimes(1);
  expect(emailRows.mock.calls[0][0].data).toEqual([
    expect.objectContaining({
      recipient: "learner@example.com",
      emailType: "SESSION_OUTCOME_PROPOSED",
    }),
  ]);
});
