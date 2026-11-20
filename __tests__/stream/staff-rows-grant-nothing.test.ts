/**
 * @jest-environment node
 */

/**
 * The only row this user holds on the event: their own row from when they were
 * a collaborator, still CONFIRMED and unpaid. Their collaboration has ended.
 */
const staffRow = { userId: "u-ex", role: "COLLABORATOR" };

type RowFilter = {
  role?: string | { not?: string; in?: string[] };
  AND?: RowFilter[];
};

/** Answers a participant filter as Postgres would for that one row. */
function selectsStaffRow(where: RowFilter | undefined): boolean {
  if (!where) return true;
  const { role } = where;
  if (typeof role === "string" && role !== staffRow.role) return false;
  if (typeof role === "object") {
    if (role.not === staffRow.role) return false;
    if (role.in && !role.in.includes(staffRow.role)) return false;
  }
  return (where.AND ?? []).every(selectsStaffRow);
}

const mockDb = {
  appointmentParticipant: {
    findMany: jest.fn(async (args: { where: RowFilter }) =>
      selectsStaffRow(args.where) ? [staffRow] : [],
    ),
  },
  webinar: { findFirst: jest.fn() },
  appointment: {
    findMany: jest.fn(
      async (args: { where: { participants: { some: RowFilter } } }) =>
        selectsStaffRow(args.where.participants.some)
          ? [{ participants: [staffRow] }]
          : [],
    ),
  },
  consultantProfile: {
    findUnique: jest.fn(async () => ({
      userId: "u-host",
      totalMenteesHelped: 0,
      webinarPlans: [],
      classPlans: [],
    })),
    update: jest.fn(),
  },
  consultation: { findMany: jest.fn(async () => []) },
  subscription: { findMany: jest.fn(async () => []) },
  trial: { findMany: jest.fn(async () => []) },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
  getStreamVideoClient: jest.fn(),
  isExpectedStreamError: () => false,
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn(),
  upsertUsersToStream: jest.fn(),
}));

import { eventParticipantsAmong } from "../../lib/stream/event-channel-service";
import { verifyEventAccess } from "../../lib/stream/chat/access";
import { getEventAttendeeIds } from "../../lib/stream/recording-utils";
import { recomputeMenteesHelped } from "../../lib/profiles/mentees-helped";

beforeEach(() => jest.clearAllMocks());

describe("a collaborator's own participant row, once the collaboration has ended", () => {
  it("does not make them a member of the event's chat", async () => {
    mockDb.webinar.findFirst.mockImplementation(
      async (args: {
        select: {
          appointment: { select: { participants: { where: RowFilter } } };
        };
      }) => ({
        webinarPlan: {
          organization: null,
          consultantProfile: { userId: "u-host", deletedAt: null },
          collaborators: [],
        },
        appointment: {
          deletedAt: null,
          organization: null,
          occurrences: [{ endsAt: new Date(Date.now() + 3_600_000) }],
          _count: { occurrences: 1 },
          participants: selectsStaffRow(
            args.select.appointment.select.participants.where,
          )
            ? [staffRow]
            : [],
        },
      }),
    );

    const admitted = await eventParticipantsAmong("webinar", "w-1", ["u-ex"]);

    expect(admitted?.has("u-ex")).toBe(false);
  });

  it("does not verify them for an event-linked channel", async () => {
    mockDb.webinar.findFirst.mockImplementation(
      async (args: {
        where: {
          OR: { appointment?: { participants: { some: RowFilter } } }[];
        };
      }) =>
        args.where.OR.some(
          (arm) =>
            arm.appointment &&
            selectsStaffRow(arm.appointment.participants.some),
        )
          ? { id: "w-1" }
          : null,
    );

    await expect(verifyEventAccess("u-ex", "webinar", "w-1")).resolves.toBe(
      false,
    );
  });

  it("is not a recipient of the event's recording notices", async () => {
    await expect(
      getEventAttendeeIds({ id: "a-1", webinar: { id: "w-1" } }),
    ).resolves.toEqual([]);
  });

  it("is not counted among the people the host has served", async () => {
    const total = await recomputeMenteesHelped(
      mockDb as unknown as Parameters<typeof recomputeMenteesHelped>[0],
      "cp-host",
    );

    expect(total).toBe(0);
  });
});
