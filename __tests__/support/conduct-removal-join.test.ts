/**
 * @jest-environment node
 */

/**
 * A second conduct removal joining its learner's unclosed case: a settled case goes
 * back to OPEN by compare-and-set on its prior status, under the REMOVAL actor,
 * decided or not; a case still under review keeps its status.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import { openOrJoinConductRemovalCaseTx } from "@/lib/support/conduct-removal-case";

const NOW = new Date("2026-11-19T10:00:00.000Z");

function txFor(status: string, moved = 1) {
  const statusCas = jest.fn(async (_args: unknown) => ({ count: moved }));
  const events: unknown[] = [];
  const tx = {
    supportCase: {
      findFirst: async () => ({
        id: "case-1",
        referenceNumber: "FAM-2026-000013",
        status,
        category: "CONDUCT_REMOVAL",
        priority: "MEDIUM",
        resolvedAt:
          status === "RESOLVED" ? new Date("2026-11-18T12:00:00Z") : null,
        acknowledgedAt: new Date("2026-11-18T11:00:00Z"),
        activeChannel: "HUMAN",
      }),
      updateMany: statusCas,
      update: async () => ({ messageSeq: 4 }),
    },
    // The case already carries an UPHELD decision.
    supportCaseDecision: { findFirst: async () => ({ id: "decision-1" }) },
    supportCaseMessage: { create: async () => ({}) },
    supportCaseEvent: {
      create: async (args: { data: unknown }) => {
        events.push(args.data);
        return {};
      },
    },
  } as unknown as Tx;
  return { tx, statusCas, events };
}

const join = (tx: Tx) =>
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

it.each(["RESOLVED", "ESCALATED"])(
  "reopens a %s removal case to OPEN by compare-and-set, decided as it is",
  async (status) => {
    const { tx, statusCas, events } = txFor(status);
    await expect(join(tx)).resolves.toEqual({
      id: "case-1",
      referenceNumber: "FAM-2026-000013",
    });
    expect(statusCas).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "case-1",
          status,
          category: "CONDUCT_REMOVAL",
          closedAt: null,
        },
        data: expect.objectContaining({ status: "OPEN", resolvedAt: null }),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "REOPENED",
        actorId: "host-1",
        fromValue: status,
        toValue: "OPEN",
      }),
    ]);
  },
);

it("keeps a case still under review as it is", async () => {
  const { tx, statusCas, events } = txFor("IN_PROGRESS");
  await join(tx);
  expect(statusCas).not.toHaveBeenCalled();
  expect(events).toEqual([
    expect.objectContaining({
      kind: "REOPENED",
      fromValue: null,
      toValue: null,
    }),
  ]);
});

it("refuses with REMOVAL_CONFLICT when the status moved under it", async () => {
  const { tx } = txFor("RESOLVED", 0);
  await expect(join(tx)).rejects.toMatchObject({ code: "REMOVAL_CONFLICT" });
});
