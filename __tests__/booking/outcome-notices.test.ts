/**
 * @jest-environment node
 */

// Invariant: a proposed negative verdict, and an ops review of one, reach every
// host and live learner seat once: one bell row per person keyed to the verdict,
// dated in that person's own zone, and one email built from the same words.

const findAppointment = jest.fn();
const findUsers = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: (...a: unknown[]) => findAppointment(...a) },
    user: { findMany: (...a: unknown[]) => findUsers(...a) },
    recording: { count: jest.fn(async () => 0) },
  },
}));
// The bell policy's own read: both users may receive the bell, each in their zone.
jest.mock("../../lib/novu/policy", () => ({
  bellRecipientZones: jest.fn(
    async (_w: string, ids: string[]) =>
      new Map(ids.map((id) => [id, ZONES[id]])),
  ),
}));
jest.mock("../../lib/novu/client", () => ({
  ...jest.requireActual("../../lib/novu/client"),
  isNovuConfigured: () => true,
}));
const prepareEmails = jest.fn(async (_args: unknown) => ({
  prepared: {
    emailType: "SESSION_OUTCOME_PROPOSED",
    entityRef: "appointment:apt-1",
    messages: [],
    skipped: 0,
    failed: 0,
  },
  screened: [],
}));
jest.mock("../../lib/email/senders/booking", () => ({
  prepareSessionOutcomeNoticeEmails: (args: unknown) => prepareEmails(args),
}));

import {
  prepareProposedOutcomeNotices,
  prepareReviewedOutcomeNotices,
  stageOutcomeNotices,
  type OutcomePartiesRow,
} from "@/lib/booking/outcome-notices";
import type { SessionOutcomeNoticeEmailArgs } from "@/lib/email/senders/booking";
import type { Tx } from "@/lib/prisma";
import { SupportThreadCategoryEnum } from "@/schemas/enums";

const ZONES: Record<string, string> = {
  host: "America/New_York",
  learner: "Asia/Kolkata",
};

const plan = (title: string) => ({
  title,
  recordingEnabled: false,
  consultantProfile: { userId: "host" },
});

/** The row `PARTIES_SELECT` returns for a paid 1:1 consultation. */
const consultation: OutcomePartiesRow = {
  organizationId: null,
  consultation: { consultationPlan: plan("Career review") },
  subscription: null,
  trial: null,
  webinar: null,
  class: null,
  participants: [{ userId: "learner" }],
  payment: [
    {
      amount: 150_000,
      currency: "INR",
      refunds: [],
      disputes: [],
    },
  ],
};

const SESSION = {
  occurrenceId: "occ-1",
  appointmentId: "apt-1",
  startsAt: new Date("2026-11-23T10:00:00Z"),
};
const OUTCOME_AT = new Date("2026-11-23T11:45:00Z");

const txWith = () => {
  const createManyAndReturn = jest.fn(
    async ({ data }: { data: { transactionId: string }[] }) =>
      data.map((row, i) => ({ id: `nb-${i}`, ...row })),
  );
  const tx = {
    notificationOutbox: { createManyAndReturn },
    failedEmail: { createManyAndReturn: jest.fn(async () => []) },
  } as unknown as Tx;
  return { tx, createManyAndReturn };
};

beforeEach(() => {
  jest.clearAllMocks();
  findAppointment.mockResolvedValue(consultation);
  findUsers.mockResolvedValue([
    { id: "host", consultantProfileId: "cp-1", consulteeProfileId: null },
    { id: "learner", consultantProfileId: null, consulteeProfileId: "ce-1" },
  ]);
});

it("stages one proposed-verdict bell per side, dated in each recipient's zone, with the refund and the report link", async () => {
  const prepared = await prepareProposedOutcomeNotices({
    ...SESSION,
    outcome: "HOST_ABSENT",
    outcomeAt: OUTCOME_AT,
  });
  const { tx, createManyAndReturn } = txWith();
  const staged = await stageOutcomeNotices(tx, prepared!);

  expect(createManyAndReturn).toHaveBeenCalledTimes(1);
  const rows = createManyAndReturn.mock.calls[0][0].data as unknown as {
    workflowId: string;
    recipients: string[];
    payload: Record<string, string>;
    transactionId: string;
  }[];
  expect(staged.bells).toHaveLength(2);
  const byUser = new Map(rows.map((r) => [r.recipients[0], r]));
  expect([...byUser.keys()].sort()).toEqual(["host", "learner"]);
  const learner = byUser.get("learner")!;
  expect(learner.workflowId).toBe("session-outcome-proposed");
  // outcomeAt + 48 h = 25 Nov 11:45 UTC: 5:15 PM in Kolkata, 6:45 AM in New York.
  expect(learner.payload).toMatchObject({
    side: "learner",
    windowClosesAt: "Wed, 25 Nov 2026 · 5:15 PM IST",
    windowClosesAtIso: "2026-11-25T11:45:00.000Z",
    reportUrl:
      "http://localhost:3000/dashboard/consultee/ce-1/support/requests/b_apt-1?intent=NO_SHOW&occurrence=occ-1",
  });
  expect(learner.payload.message).toContain(
    "We'll refund ₹1,500.00 automatically after Wed, 25 Nov 2026 · 5:15 PM IST, or sooner if you confirm the expert didn't join.",
  );
  expect(learner.payload.message).not.toMatch(/reliability|strike/i);
  const host = byUser.get("host")!;
  expect(host.payload.windowClosesAt).toBe("Wed, 25 Nov 2026 · 6:45 AM EST");
  expect(host.payload.reportUrl).toContain(
    "/dashboard/consultant/cp-1/support/requests/b_apt-1?intent=NO_SHOW&occurrence=occ-1",
  );
  expect(host.payload.message).toContain("only you and our team see");
  // The request page seeds its turn from `?intent=`, which must name a flow category.
  const intent = new URL(learner.payload.reportUrl).searchParams.get("intent");
  expect(SupportThreadCategoryEnum.parse(intent)).toBe("NO_SHOW");
  expect(new Set(rows.map((r) => r.transactionId)).size).toBe(2);

  // The email is built from the same words, in the email recipient's own zone.
  const emailArgs = prepareEmails.mock
    .calls[0][0] as unknown as SessionOutcomeNoticeEmailArgs;
  expect(emailArgs).toMatchObject({
    emailType: "SESSION_OUTCOME_PROPOSED",
    userIds: ["host", "learner"],
  });
  expect(emailArgs.noticeFor("learner", "Asia/Kolkata").copy.lines).toEqual(
    learner.payload.message.split(/(?<=\.) /),
  );
});

it("keys each bell to the verdict, so staging the same proposal again inserts the same rows", async () => {
  const args = { ...SESSION, outcome: "LEARNER_ABSENT" as const };
  const first = await prepareProposedOutcomeNotices({
    ...args,
    outcomeAt: OUTCOME_AT,
  });
  const again = await prepareProposedOutcomeNotices({
    ...args,
    outcomeAt: OUTCOME_AT,
  });
  const { tx, createManyAndReturn } = txWith();
  await stageOutcomeNotices(tx, first!);
  await stageOutcomeNotices(tx, again!);
  const ids = createManyAndReturn.mock.calls.map((c) =>
    c[0].data.map((r) => r.transactionId),
  );
  expect(ids[0]).toEqual(ids[1]);
  // The insert skips a duplicate transactionId, so the second stage adds nothing.
  expect(createManyAndReturn.mock.calls[1][0]).toMatchObject({
    skipDuplicates: true,
  });
});

it("stages one reviewed notice per side that opens the booking", async () => {
  const prepared = await prepareReviewedOutcomeNotices({
    ...SESSION,
    outcome: "HELD",
    reviewedAt: OUTCOME_AT,
  });
  const { tx, createManyAndReturn } = txWith();
  await stageOutcomeNotices(tx, prepared!);
  const rows = createManyAndReturn.mock.calls[0][0].data as unknown as {
    workflowId: string;
    recipients: string[];
    payload: Record<string, string>;
  }[];
  expect(rows.map((r) => r.recipients[0]).sort()).toEqual(["host", "learner"]);
  for (const row of rows) {
    expect(row.workflowId).toBe("session-outcome-reviewed");
    expect(row.payload.message).toContain("Our record now shows it was held.");
    expect(row.payload.dashboardUrl).toBe(
      "http://localhost:3000/dashboard/go/auto/appointments/apt-1",
    );
  }
  expect(
    rows.find((r) => r.recipients[0] === "learner")!.payload.dateTime,
  ).toBe("Mon, 23 Nov 2026 · 3:30 PM IST");
});
