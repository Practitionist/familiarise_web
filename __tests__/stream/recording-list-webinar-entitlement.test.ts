/**
 * @jest-environment node
 */

const mockFindMany = jest.fn();
const mockCount = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { listRecordingsScoped } from "../../lib/api/scope/list-recordings";
import { LIVE_PARTICIPANT_STATUSES } from "../../lib/booking/participants";

type SharedPlanArm = {
  webinar: {
    webinarPlan: {
      webinars: {
        some: {
          appointment: {
            participants: {
              some: { userId: string; status: Record<string, unknown> };
            };
          };
        };
      };
    };
  };
};

describe("listRecordingsScoped: plan-wide webinar recordings", () => {
  beforeEach(() => {
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
  });

  it("admits only a live seat, so a REFUNDED or CANCELLED attendee loses every run", async () => {
    await listRecordingsScoped({ scope: { kind: "personal" }, userId: "u-1" });

    const where = mockFindMany.mock.calls[0][0].where;
    const arms = where.meeting.occurrence.appointment.OR as unknown[];
    const shared = arms.find(
      (arm): arm is SharedPlanArm =>
        typeof arm === "object" &&
        arm !== null &&
        "webinar" in arm &&
        JSON.stringify(arm).includes("shareRecordingsWithAllAttendees"),
    );
    expect(shared).toBeDefined();
    const seat =
      shared?.webinar.webinarPlan.webinars.some.appointment.participants.some;
    expect(seat).toEqual({
      userId: "u-1",
      status: { in: LIVE_PARTICIPANT_STATUSES },
    });
    expect(LIVE_PARTICIPANT_STATUSES).not.toContain("REFUNDED");
  });
});
