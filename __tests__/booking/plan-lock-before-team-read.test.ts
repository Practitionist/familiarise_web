/**
 * @jest-environment node
 */

/**
 * A writer that changes a webinar or class plan's session times writes the
 * plan row before it reads the team, and refuses when the team holds a profile
 * whose calendar its slot batch never took.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../utils/appointmentlock", () => ({}));

import {
  HostTimeHeldError,
  lockPlanForMove,
} from "@/lib/booking/host-slot-batch";
import { lockPlanForAllocation } from "@/lib/booking/allocation/collaborators";
import { AllocationRaceError } from "@/lib/booking/allocation/slot-batch";
import type { Tx } from "@/lib/prisma";

function planTx(team: string[]) {
  const log: string[] = [];
  const tx = {
    $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      log.push(`${sql.join("?").trim()} [${values.join(",")}]`);
      return 1;
    },
    collaborator: {
      findMany: async () => {
        log.push("team read");
        return team.map((consultantProfileId) => ({ consultantProfileId }));
      },
    },
  };
  return { tx: tx as unknown as Tx, log };
}

describe("the plan lock a schedule writer takes", () => {
  it("writes the plan row, keeping its values, before it reads the team", async () => {
    const webinar = planTx(["cohost"]);
    await lockPlanForMove(webinar.tx, "WEBINAR", "plan-1", ["host", "cohost"]);
    expect(webinar.log).toEqual([
      'UPDATE "WebinarPlan" SET "updatedAt" = "updatedAt" WHERE "id" = ? [plan-1]',
      "team read",
    ]);

    const cls = planTx([]);
    await lockPlanForMove(cls.tx, "CLASS", "plan-2", ["host"]);
    expect(cls.log[0]).toBe(
      'UPDATE "ClassPlan" SET "updatedAt" = "updatedAt" WHERE "id" = ? [plan-2]',
    );
  });

  it("refuses a move when the team holds a profile the batch did not lock", async () => {
    const { tx } = planTx(["cohost", "just-accepted"]);
    await expect(
      lockPlanForMove(tx, "CLASS", "plan-1", ["host", "cohost"]),
    ).rejects.toBeInstanceOf(HostTimeHeldError);
  });

  it("answers an allocation the same way, as a retryable race", async () => {
    const { tx } = planTx(["just-accepted"]);
    await expect(
      lockPlanForAllocation(tx, "webinar", "plan-1", ["host"]),
    ).rejects.toBeInstanceOf(AllocationRaceError);
  });

  it("takes no plan lock for a 1:1 or a subscription", async () => {
    const { tx, log } = planTx(["anyone"]);
    await lockPlanForAllocation(tx, "consultation", "plan-1", ["host"]);
    await lockPlanForAllocation(tx, "subscription", "plan-1", ["host"]);
    expect(log).toEqual([]);
  });
});
