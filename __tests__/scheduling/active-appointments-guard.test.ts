/**
 * The schedule-type switch guard counts every row the occupancy policy treats
 * as occupying a slot. Trials and open reschedule requests were missing, so a
 * consultant with an accepted trial could switch type underneath it.
 */

import { checkActiveAppointments } from "../../app/api/user/consultants/utils/consultant-appointments";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

function db(counts: Partial<Record<string, number>>) {
  const count = (key: string) => ({
    count: jest.fn(async () => counts[key] ?? 0),
  });
  return {
    consultation: count("consultation"),
    subscription: count("subscription"),
    webinar: count("webinar"),
    class: count("class"),
    trial: count("trial"),
    rescheduleRequest: count("rescheduleRequest"),
  } as unknown as Parameters<typeof checkActiveAppointments>[1];
}

describe("checkActiveAppointments", () => {
  it("is clear when every bucket is empty", async () => {
    const result = await checkActiveAppointments("cp-1", db({}));
    expect(result.hasActive).toBe(false);
    expect(result.total).toBe(0);
    expect(result.details).toBeUndefined();
  });

  it("counts an active trial as blocking", async () => {
    const result = await checkActiveAppointments("cp-1", db({ trial: 1 }));
    expect(result.hasActive).toBe(true);
    expect(result.breakdown.activeTrials).toBe(1);
    expect(result.details).toBe("1 active trial");
  });

  it("counts an open reschedule request as blocking", async () => {
    const result = await checkActiveAppointments(
      "cp-1",
      db({ rescheduleRequest: 2 }),
    );
    expect(result.hasActive).toBe(true);
    expect(result.details).toBe("2 open reschedule requests");
  });

  it("queries trials by the statuses the occupancy policy treats as live", async () => {
    const mocked = db({});
    await checkActiveAppointments("cp-1", mocked);
    const trialCount = (mocked as unknown as { trial: { count: jest.Mock } })
      .trial.count;
    expect(trialCount).toHaveBeenCalledWith({
      where: {
        consultantProfileId: "cp-1",
        status: { in: ["SCHEDULED", "AWAITING_PAYMENT"] },
      },
    });
  });
});
