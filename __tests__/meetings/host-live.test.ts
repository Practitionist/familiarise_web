/**
 * @jest-environment node
 */

// "Host is live": the first host join claims the occurrence and rings its paid seats once.

const createMany = jest.fn();
const findUnique = jest.fn();
const tx = {
  idempotencyRecord: { createMany: (...a: unknown[]) => createMany(...a) },
  appointmentOccurrence: { findUnique: (...a: unknown[]) => findUnique(...a) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));
const stageBell = jest.fn(async () => ({ id: "row-1" }));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...a: unknown[]) => stageBell(...(a as [])),
}));
jest.mock("../../lib/novu/outbox", () => ({ attemptTrigger: jest.fn() }));

import { stageHostLiveBell } from "../../lib/meetings/host-live";
import { paidParticipant } from "../../lib/booking/participants";

findUnique.mockResolvedValue({
  appointment: {
    id: "appt-1",
    organizationId: null,
    appointmentType: "WEBINAR",
    participants: [{ userId: "seat-1" }, { userId: "seat-2" }],
    webinar: {
      webinarPlan: {
        title: "Deep work",
        consultantProfile: { user: { name: "Hannah" } },
      },
    },
  },
});

it("rings the paid seats on the first claim and nothing on a later join", async () => {
  createMany.mockResolvedValueOnce({ count: 1 });
  await expect(stageHostLiveBell("occ-1")).resolves.toEqual({ id: "row-1" });

  expect(createMany.mock.calls[0][0]).toMatchObject({
    data: { scope: "meeting.host-live", key: "occ-1" },
    skipDuplicates: true,
  });
  const select = findUnique.mock.calls[0][0].select.appointment.select;
  expect(select.participants.where).toEqual({
    ...paidParticipant(),
    role: "CONSULTEE",
  });
  expect(stageBell).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      workflowId: "session-host-live",
      recipients: ["seat-1", "seat-2"],
      dedupeKey: "host-live:occ-1",
      payload: expect.objectContaining({
        consultantName: "Hannah",
        planTitle: "Deep work",
      }),
    }),
  );

  createMany.mockResolvedValueOnce({ count: 0 });
  await expect(stageHostLiveBell("occ-1")).resolves.toBeNull();
  expect(stageBell).toHaveBeenCalledTimes(1);
});
