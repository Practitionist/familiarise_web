/**
 * Until the busy-time ledger lands, a re-plan's hard delete keeps history:
 * tombstoned and cancelled rows are neither deleted nor freed (and keep their
 * wrapper), and a session carrying an incident remedy refuses the re-plan
 * rather than cascading the remedy away.
 */

import "./setup";

import { deleteExistingAppointments } from "@/lib/booking/allocation/commit/release-tentative";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import type { Tx } from "@/lib/prisma";

const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const LATER = new Date(FUTURE.getTime() + 60 * 60_000);

function row(over: Record<string, unknown>) {
  return {
    id: "o",
    ordinal: 1,
    startsAt: FUTURE,
    endsAt: LATER,
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    meeting: null,
    _count: { incidentRemedies: 0 },
    ...over,
  };
}

function txWith(occurrences: Array<Record<string, unknown>>) {
  return {
    appointment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "apt-1",
          participants: [],
          occurrences,
          _count: { payment: 0 },
        },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appointmentOccurrence: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe("re-plan hard delete (interim guard)", () => {
  it("keeps a cancelled tombstone and its wrapper, deleting only live rows", async () => {
    const tx = txWith([
      row({ id: "live", ordinal: 1 }),
      row({
        id: "tomb",
        ordinal: 2,
        completionStatus: "CANCELLED",
        deletedAt: new Date(),
      }),
    ]);
    const result = await deleteExistingAppointments(
      tx as unknown as Tx,
      "class",
      "class-1",
    );
    expect(tx.appointment.deleteMany).not.toHaveBeenCalled();
    expect(tx.appointmentOccurrence.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        appointmentId: "apt-1",
        deletedAt: null,
        completionStatus: { not: "CANCELLED" },
      }),
    });
    expect(result.freedOrdinals).toEqual([1]);
  });

  it("refuses to delete a session that carries an incident remedy", async () => {
    const tx = txWith([row({ _count: { incidentRemedies: 1 } })]);
    const refusal = await deleteExistingAppointments(
      tx as unknown as Tx,
      "class",
      "class-1",
    ).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AllocationConflictError);
    expect((refusal as AllocationConflictError).errorCode).toBe(
      "SESSION_HAS_REMEDY",
    );
    expect(tx.appointmentOccurrence.deleteMany).not.toHaveBeenCalled();
    expect(tx.appointment.deleteMany).not.toHaveBeenCalled();
  });
});
