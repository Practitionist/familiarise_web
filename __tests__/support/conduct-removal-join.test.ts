/**
 * @jest-environment node
 */

/**
 * A second conduct removal and the learner's unclosed removal case: an undecided
 * case is joined and keeps its status; a decided one is closed by compare-and-set
 * and a fresh case opens for the new removal.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/support/reference", () => ({
  allocateTicketReference: async () => "FAM-2026-000020",
}));
jest.mock("../../lib/support/case-service", () => ({
  stageSupportCaseIntakeTx: async () => undefined,
}));
const mockRelease = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../../lib/support/system-case-close", () => ({
  releaseSystemClosedCaseTx: (...args: unknown[]) => mockRelease(...args),
  // Nothing holds the old case's payouts in these cases.
  systemCloseHoldRefusalTx: async () => null,
  endSystemClosedChatTx: async () => undefined,
}));

import type { Tx } from "@/lib/prisma";
import { openOrJoinConductRemovalCaseTx } from "@/lib/support/conduct-removal-case";

const NOW = new Date("2026-11-19T10:00:00.000Z");

function txFor(opts: { status: string; decided: boolean; closes?: number }) {
  const statusCas = jest.fn(async (_args: unknown) => ({
    count: opts.closes ?? 1,
  }));
  const created = jest.fn(async (_args: unknown) => ({
    id: "case-2",
    referenceNumber: "FAM-2026-000020",
  }));
  const deadline = jest.fn(async (_args: unknown) => ({ messageSeq: 4 }));
  const events: unknown[] = [];
  const tx = {
    supportCase: {
      findFirst: async () => ({
        id: "case-1",
        referenceNumber: "FAM-2026-000013",
        status: opts.status,
        category: "CONDUCT_REMOVAL",
      }),
      updateMany: statusCas,
      update: deadline,
      create: created,
    },
    supportCaseDecision: {
      findFirst: async () => (opts.decided ? { id: "decision-1" } : null),
    },
    supportCaseMessage: { create: async () => ({}) },
    supportCaseEvent: {
      create: async (args: { data: unknown }) => {
        events.push(args.data);
        return {};
      },
    },
  } as unknown as Tx;
  return { tx, statusCas, created, deadline, events };
}

const removeAgain = (tx: Tx) =>
  openOrJoinConductRemovalCaseTx(
    tx,
    {
      appointmentId: "appt-1",
      removedUserId: "learner-1",
      actorUserId: "host-1",
      eventTitle: "Intro to Python",
      reasonLabel: "Harassment",
      note: null,
    },
    NOW,
  );

it("closes a decided case by compare-and-set and opens a fresh case for the new removal", async () => {
  const { tx, statusCas, created, events } = txFor({
    status: "RESOLVED",
    decided: true,
  });
  await expect(removeAgain(tx)).resolves.toEqual({
    id: "case-2",
    referenceNumber: "FAM-2026-000020",
  });
  expect(statusCas).toHaveBeenCalledWith({
    where: {
      id: "case-1",
      status: "RESOLVED",
      category: "CONDUCT_REMOVAL",
      closedAt: null,
    },
    data: { status: "CLOSED", closedAt: NOW },
  });
  expect(mockRelease).toHaveBeenCalledWith(
    tx,
    "case-1",
    NOW,
    expect.any(String),
  );
  expect(created).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    expect.objectContaining({
      caseId: "case-1",
      kind: "STATUS_CHANGED",
      fromValue: "RESOLVED",
      toValue: "CLOSED",
      note: expect.stringContaining("FAM-2026-000020"),
    }),
  ]);
});

it("joins an undecided case: its status stays and its deadline restarts", async () => {
  const { tx, statusCas, created, deadline, events } = txFor({
    status: "ESCALATED",
    decided: false,
  });
  await expect(removeAgain(tx)).resolves.toEqual({
    id: "case-1",
    referenceNumber: "FAM-2026-000013",
  });
  expect(statusCas).not.toHaveBeenCalled();
  expect(created).not.toHaveBeenCalled();
  expect(deadline).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "case-1" },
      data: expect.objectContaining({
        statutoryDueAt: new Date(NOW.getTime() + 72 * 3_600_000),
      }),
    }),
  );
  expect(events).toEqual([
    expect.objectContaining({ caseId: "case-1", actorId: "host-1" }),
  ]);
});

it("refuses with REMOVAL_CONFLICT when the decided case moved under the close", async () => {
  const { tx, created } = txFor({
    status: "RESOLVED",
    decided: true,
    closes: 0,
  });
  await expect(removeAgain(tx)).rejects.toMatchObject({
    code: "REMOVAL_CONFLICT",
  });
  expect(created).not.toHaveBeenCalled();
});
