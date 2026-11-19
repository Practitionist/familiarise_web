/**
 * @jest-environment node
 *
 * What the switch route answers becomes the lock's sentences: its counts as
 * a list, then what to do.
 */
import { NextRequest } from "next/server";

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "u-expert" } })),
}));
jest.mock("../../lib/prisma", () => {
  const count = (n: number) => ({ count: jest.fn(async () => n) });
  return {
    __esModule: true,
    default: {
      consultantProfile: {
        findUnique: jest.fn(async () => ({
          id: "cp-1",
          userId: "u-expert",
          scheduleType: "WEEKLY",
        })),
      },
      consultation: count(15),
      subscription: count(0),
      webinar: count(0),
      class: count(2),
      trial: count(0),
      rescheduleRequest: count(1),
      collaborator: count(0),
    },
  };
});

import { GET } from "@/app/api/user/consultants/[id]/can-switch-schedule/route";
import { scheduleLockReason } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/schedule-lock";

it("turns the switch route's counts into sentences", async () => {
  const res = await GET(
    new NextRequest(
      "http://localhost/api/user/consultants/cp-1/can-switch-schedule",
    ),
    { params: Promise.resolve({ id: "cp-1" }) },
  );
  expect(scheduleLockReason(await res.json())).toBe(
    "You have 15 pending consultations, 2 upcoming classes and 1 open reschedule request. " +
      "Complete or cancel them before you switch schedule types.",
  );
});

it("says nothing when the switch is open", () => {
  expect(scheduleLockReason({ canSwitch: true })).toBeNull();
});
