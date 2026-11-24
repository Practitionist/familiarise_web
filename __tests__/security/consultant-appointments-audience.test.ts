/**
 * @jest-environment node
 */

/**
 * The appointments list read serves a plan's owner, its collaborators and its
 * attendees through one query. A webinar row carries each co-host's role and
 * never a share, another attendee's payment never rides a webinar or class
 * row, and a former collaborator's old participant row lists nothing.
 */

import prisma from "@/lib/prisma";
import { readConsultantAppointmentsPage } from "@/lib/data/consultant-appointments";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointment: { findMany: jest.fn() }, $queryRaw: jest.fn() },
}));

const findMany = prisma.appointment.findMany as jest.Mock;

/** A stored collaborator row, every column. */
const STORED_COLLABORATOR = {
  id: "collab-1",
  role: "CO_HOST",
  tier: "PRESENTER",
  status: "ACCEPTED",
  revenueShareBps: 4000,
  invitedById: "host-profile",
  consultantProfileId: "cohost-profile",
};

type Select = Record<string, unknown>;
type ListQuery = {
  where: { AND: [{ AND?: { participants?: { some: Select } }[] }, unknown] };
  include: {
    payment: { where: { OR: unknown[] } };
    webinar: {
      include: {
        webinarPlan: { include: { collaborators: { select: Select } } };
      };
    };
  };
};

/** Answers the read's own `select` for the co-host rows, as the database would. */
function seedList() {
  findMany.mockImplementation(async (args: ListQuery) => {
    const { select } =
      args.include.webinar.include.webinarPlan.include.collaborators;
    return [
      {
        id: "appt-1",
        createdAt: new Date("2026-11-01T00:00:00Z"),
        occurrences: [],
        _count: { participants: 0, occurrences: 0 },
        webinar: {
          webinarPlan: {
            collaborators: [
              Object.fromEntries(
                Object.entries(STORED_COLLABORATOR).filter(
                  ([k]) => k in select,
                ),
              ),
            ],
          },
        },
      },
    ];
  });
}

const firstQuery = () => findMany.mock.calls[0][0] as ListQuery;
const GROUP_ROWS_CARRY_NO_OTHER_BUYER = {
  appointment: { appointmentType: { notIn: ["WEBINAR", "CLASS"] } },
};

beforeEach(() => jest.clearAllMocks());

describe("appointments list by audience", () => {
  it("a collaborator's list row names each co-host's role and never a share", async () => {
    seedList();
    const { rows } = await readConsultantAppointmentsPage({
      consultantProfileId: "crew-profile",
      scope: { kind: "personal" },
    });
    const cohost = (
      rows[0] as unknown as {
        webinar: { webinarPlan: { collaborators: Select[] } };
      }
    ).webinar.webinarPlan.collaborators[0];
    expect(cohost).toEqual({
      id: "collab-1",
      role: "CO_HOST",
      consultantProfileId: "cohost-profile",
    });
    expect(cohost).not.toHaveProperty("revenueShareBps");
    expect(cohost).not.toHaveProperty("invitedById");
    // No buyer filter on an expert's read: a webinar or class row carries no payment.
    expect(firstQuery().include.payment.where.OR).toEqual([
      GROUP_ROWS_CARRY_NO_OTHER_BUYER,
    ]);
  });

  it("an attendee's read carries their own payments and ignores a collaborator's old row", async () => {
    seedList();
    await readConsultantAppointmentsPage({
      userId: "buyer-a",
      scope: { kind: "personal" },
    });
    const query = firstQuery();
    expect(query.include.payment.where.OR).toEqual([
      GROUP_ROWS_CARRY_NO_OTHER_BUYER,
      { userId: "buyer-a" },
    ]);
    expect(query.where.AND[0].AND?.[0].participants?.some).toMatchObject({
      userId: "buyer-a",
      role: { not: "COLLABORATOR" },
    });
  });
});
