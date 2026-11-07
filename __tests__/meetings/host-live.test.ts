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
import { stageHostLiveBell } from "../../lib/meetings/host-live";
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
  const first = await stageHostLiveBell("occ-1");

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
  expect(first).toHaveLength(2);

  createMany.mockResolvedValueOnce({ count: 0 });
  await expect(stageHostLiveBell("occ-1")).resolves.toEqual([]);
  expect(createManyAndReturn).toHaveBeenCalledTimes(1);
});

describe("each bell carries its recipient's own scope", () => {
  const stage = async (appointment: Record<string, unknown>) => {
    createMany.mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValueOnce({
      appointment: {
        id: "appt-2",
        appointmentType: "WEBINAR",
        webinar: {
          webinarPlan: { title: "Deep work", consultantProfile: null },
        },
        ...appointment,
      },
    });
    createManyAndReturn.mockClear();
    await stageHostLiveBell("occ-2");
    return createManyAndReturn.mock.calls.flatMap(
      ([{ data }]) =>
        data as Array<{
          recipients: string[];
          payload: Record<string, unknown>;
        }>,
    );
  };

  it("gives a sponsored seat its sponsor's scope and a personal seat on an org-hosted event a personal one", async () => {
    const pages = await stage({
      organizationId: "org-host",
      participants: [
        { userId: "sponsored", organizationId: "org-sponsor" },
        { userId: "self-paid", organizationId: null },
      ],
    });
    const scopeOf = (userId: string) =>
      pages.find((p) => p.recipients.includes(userId))?.payload;
    expect(scopeOf("sponsored")).toMatchObject({
      scope: "org",
      organizationId: "org-sponsor",
    });
    expect(scopeOf("self-paid")).toMatchObject({
      scope: "personal",
      organizationId: null,
    });
  });

  it("splits 150 mixed seats into attempt-sized pages per scope", async () => {
    const orgOf = (i: number) =>
      i % 3 === 0 ? "org-a" : i % 3 === 1 ? "org-b" : null;
    const pages = await stage({
      organizationId: null,
      participants: Array.from({ length: 150 }, (_, i) => ({
        userId: `s-${i}`,
        organizationId: orgOf(i),
      })),
    });
    expect(pages.every((p) => p.recipients.length <= 100)).toBe(true);
    for (const page of pages) {
      for (const userId of page.recipients) {
        expect(page.payload.organizationId).toBe(
          orgOf(Number(userId.slice(2))),
        );
      }
    }
    expect(pages.flatMap((p) => p.recipients)).toHaveLength(150);
  });

  it("keeps a 1:1 booking's appointment scope", async () => {
    const pages = await stage({
      appointmentType: "CONSULTATION",
      organizationId: "org-payer",
      webinar: null,
      consultation: {
        consultationPlan: { title: "1:1", consultantProfile: null },
      },
      participants: [{ userId: "buyer", organizationId: null }],
    });
    expect(pages[0].payload).toMatchObject({
      scope: "org",
      organizationId: "org-payer",
    });
  });
});
