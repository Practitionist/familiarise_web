/**
 * @jest-environment node
 */

// "Host is live": the first host join claims the occurrence and rings every paid seat once, page by page.

const createMany = jest.fn();
const findUnique = jest.fn();
const createManyAndReturn = jest.fn(async ({ data }: { data: unknown[] }) =>
  data.map((row, i) => ({ id: `row-${i}`, ...(row as object) })),
);
const tx = {
  idempotencyRecord: { createMany: (...a: unknown[]) => createMany(...a) },
  appointmentOccurrence: { findUnique: (...a: unknown[]) => findUnique(...a) },
  notificationOutbox: { createManyAndReturn },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));
jest.mock("../../lib/novu/policy", () => ({
  resolveRecipientBellPolicy: jest.fn(async (_w: string, ids: string[]) => ({
    allowedRecipients: ids,
  })),
}));
const attemptTrigger = jest.fn();
jest.mock("../../lib/novu/outbox", () => ({
  ...jest.requireActual("../../lib/novu/outbox"),
  attemptTrigger: (...a: unknown[]) => attemptTrigger(...a),
}));

import { announceHostLive } from "../../lib/meetings/host-live";
import { paidParticipant } from "../../lib/booking/participants";

const seats = Array.from({ length: 150 }, (_, i) => ({ userId: `seat-${i}` }));
findUnique.mockResolvedValue({
  appointment: {
    id: "appt-1",
    organizationId: null,
    appointmentType: "WEBINAR",
    participants: seats,
    webinar: {
      webinarPlan: {
        title: "Deep work",
        consultantProfile: { user: { name: "Hannah" } },
      },
    },
  },
});

it("rings all paid seats in attempt-sized pages on the first claim, and nothing on a later join", async () => {
  createMany.mockResolvedValueOnce({ count: 1 });
  await announceHostLive("occ-1");

  expect(createMany.mock.calls[0][0]).toMatchObject({
    data: { scope: "meeting.host-live", key: "occ-1" },
    skipDuplicates: true,
  });
  const select = findUnique.mock.calls[0][0].select.appointment.select;
  expect(select.participants.where).toEqual({
    ...paidParticipant(),
    role: "CONSULTEE",
  });
  const pages = createManyAndReturn.mock.calls[0][0].data as Array<{
    workflowId: string;
    recipients: string[];
  }>;
  expect(pages.map((p) => p.recipients.length)).toEqual([100, 50]);
  expect(pages.flatMap((p) => p.recipients)).toEqual(
    seats.map((s) => s.userId),
  );
  expect(pages[0].workflowId).toBe("session-host-live");
  expect(attemptTrigger).toHaveBeenCalledTimes(2);

  createMany.mockResolvedValueOnce({ count: 0 });
  await announceHostLive("occ-1");
  expect(createManyAndReturn).toHaveBeenCalledTimes(1);
  expect(attemptTrigger).toHaveBeenCalledTimes(2);
});
