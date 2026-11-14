/**
 * A booking a reschedule put back to PENDING is never a request to decline:
 * the client's proposal is accepted (or placed) or turned down to keep the
 * original time, the consultant's own proposal waits on the client and can
 * only be withdrawn, and the row's clock is the proposal's own expiry.
 */

// The inbox reaches payout setup, whose clawback notices load the email stack (unloadable in jsdom).
jest.mock("@/lib/payments/payouts/clawback-notifications", () => ({
  stageClawbackNotice: jest.fn(),
  stageRaisedClawback: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import {
  proposalLine,
  rowActions,
} from "@/components/dashboard/shared/requests/InboxRow";
import { proposalAnswerToast } from "@/components/dashboard/shared/requests/labels";
import {
  CP,
  NOW,
  hoursAhead,
  movingConsultation,
  serve,
  serveInboxFixture,
} from "../fixtures/requests-inbox";

type MockPrisma = Parameters<typeof serveInboxFixture>[0];
const viewer = { zone: "Asia/Kolkata", own: true };

async function rowFor(...args: Parameters<typeof movingConsultation>) {
  const m = prisma as unknown as MockPrisma;
  serveInboxFixture(m);
  const c = serve([movingConsultation(...args)]);
  m.consultation.findMany.mockImplementation(c.findMany);
  m.consultation.count.mockImplementation(c.count);
  const { rows } = await readRequestsInbox({
    consultantProfileId: CP,
    type: "consultation",
    sort: "priority",
    page: 1,
    now: NOW,
  });
  const row = rows.find((r) => r.id === "c-moving");
  if (!row) throw new Error("moving row missing");
  return row;
}

const actionsOf = (row: Awaited<ReturnType<typeof rowFor>>) =>
  rowActions(
    row,
    deriveBookingPresentation(row.presentation, "CONSULTANT", { now: NOW }),
  );

beforeEach(() => jest.clearAllMocks());

describe("Requests inbox rows for a booking being moved", () => {
  it("the client's proposal with times: Accept, or keep the original — never Decline", async () => {
    const row = await rowFor("CONSULTEE", true);
    expect(actionsOf(row)).toEqual({
      primary: { kind: "accept-proposal" },
      secondary: [{ kind: "keep-original" }],
    });
    expect(row.bucket).toBe("answer-today");
    expect(new Date(row.deadline!).getTime()).toBe(hoursAhead(20).getTime());
    expect(proposalLine(row, viewer)).toMatch(
      /^Priya Nair asked to move · proposed /,
    );
  });

  it("the client's 'any time works': pick a new time, or keep the original", async () => {
    const row = await rowFor("CONSULTEE", false);
    expect(actionsOf(row)).toEqual({
      primary: { kind: "place-new-time" },
      secondary: [{ kind: "keep-original" }],
    });
    expect(proposalLine(row, viewer)).toBe(
      "Priya Nair asked to move · any time works — you pick",
    );
  });

  it("the consultant's own proposal waits on the client, with Withdraw only", async () => {
    const row = await rowFor("CONSULTANT", true);
    expect(actionsOf(row)).toEqual({
      primary: null,
      secondary: [{ kind: "withdraw-proposal" }],
    });
    expect(row.bucket).toBe("waiting-on-them");
    expect(proposalLine(row, viewer)).toMatch(
      /^You asked to move this to .* · waiting for Priya Nair$/,
    );
  });

  it("the consultant's own 'any time works' offers no placement the server refuses", async () => {
    const row = await rowFor("CONSULTANT", false);
    expect(actionsOf(row)).toEqual({
      primary: null,
      secondary: [{ kind: "withdraw-proposal" }],
    });
  });

  it("no moving row ever offers Decline", async () => {
    for (const [by, times] of [
      ["CONSULTEE", true],
      ["CONSULTEE", false],
      ["CONSULTANT", true],
      ["CONSULTANT", false],
    ] as const) {
      const actions = actionsOf(await rowFor(by, times));
      const kinds = [actions.primary, ...actions.secondary].map((a) => a?.kind);
      expect(kinds).not.toContain("decline");
    }
  });
});

describe("a move past its deadline, before the sweep ends it", () => {
  it("offers nothing to answer and reads by the status the restore writes", async () => {
    const m = prisma as unknown as MockPrisma;
    serveInboxFixture(m);
    const moving = movingConsultation("CONSULTEE", true);
    const lapsed = {
      ...moving,
      appointment: {
        ...moving.appointment,
        rescheduleRequests: moving.appointment.rescheduleRequests.map((r) => ({
          ...r,
          expiresAt: new Date(NOW.getTime() - 60_000),
          originStatus: "APPROVED",
        })),
      },
    };
    const c = serve([lapsed]);
    m.consultation.findMany.mockImplementation(c.findMany);
    m.consultation.count.mockImplementation(c.count);
    const { rows } = await readRequestsInbox({
      consultantProfileId: CP,
      type: "consultation",
      sort: "priority",
      page: 1,
      now: NOW,
    });
    const row = rows.find((r) => r.id === "c-moving");
    if (!row) return;
    const actions = actionsOf(row);
    const kinds = [actions.primary, ...actions.secondary].map((a) => a?.kind);
    expect(kinds).not.toContain("accept-proposal");
    expect(kinds).not.toContain("keep-original");
    expect(row.proposal).toBeNull();
    expect(
      deriveBookingPresentation(row.presentation, "CONSULTANT", { now: NOW })
        .bookingState.state,
    ).not.toBe("BEING_MOVED");
  });
});

describe("answering a reschedule from the inbox", () => {
  it("never claims the original time was kept when it was taken meanwhile", () => {
    expect(proposalAnswerToast("keep-original", "DECLINED")).toBe(
      "Kept the original time",
    );
    expect(proposalAnswerToast("keep-original", "RELEASED")).toBe(
      "That time was taken meanwhile — pick a new one",
    );
    expect(proposalAnswerToast("withdraw-proposal", undefined)).toBe(
      "Request withdrawn",
    );
  });
});
