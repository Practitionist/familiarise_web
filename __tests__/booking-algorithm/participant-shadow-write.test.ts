/**
 * @jest-environment node
 */

/**
 * #1319 A9 — the participant table is a shadow write: every slot writer must
 * record it in the same transaction, and every removal must flip it. The
 * helper is unit-tested; the writer sites are pinned at source level so a
 * future slot writer that forgets the participant row fails here.
 */

import fs from "fs";
import path from "path";
import {
  recordParticipants,
  setParticipantStatus,
  linkParticipantsToPayment,
} from "../../lib/booking/participants";

type Tx = Parameters<typeof recordParticipants>[0];

function tx() {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const updateMany = jest.fn().mockResolvedValue({ count: 2 });
  return {
    tx: { appointmentParticipant: { createMany, updateMany } } as unknown as Tx,
    createMany,
    updateMany,
  };
}

describe("recordParticipants", () => {
  it("is idempotent (skipDuplicates) and dedupes a user named twice", async () => {
    const { tx: t, createMany } = tx();
    await recordParticipants(
      t,
      "apt_1",
      [
        { userId: "u1", role: "CONSULTANT" },
        { userId: "u2", role: "CONSULTEE" },
        { userId: "u2", role: "CONSULTEE" },
      ],
      { organizationId: "org1", status: "HELD" },
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          appointmentId: "apt_1",
          userId: "u1",
          role: "CONSULTANT",
          status: "HELD",
          paymentId: null,
          organizationId: "org1",
        },
        {
          appointmentId: "apt_1",
          userId: "u2",
          role: "CONSULTEE",
          status: "HELD",
          paymentId: null,
          organizationId: "org1",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("does nothing for an empty entry list", async () => {
    const { tx: t, createMany } = tx();
    await recordParticipants(t, "apt_1", []);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("setParticipantStatus / linkParticipantsToPayment", () => {
  it("updates by an arbitrary where and returns the count", async () => {
    const { tx: t, updateMany } = tx();
    const n = await setParticipantStatus(
      t,
      { appointment: { classId: "k1" }, userId: "u2" },
      "CANCELLED",
    );
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { appointment: { classId: "k1" }, userId: "u2" },
      data: { status: "CANCELLED" },
    });
  });

  it("links only rows that have no payment yet", async () => {
    const { tx: t, updateMany } = tx();
    await linkParticipantsToPayment(t, "apt_1", "pay_1", "u2");
    expect(updateMany).toHaveBeenCalledWith({
      where: { appointmentId: "apt_1", paymentId: null, userId: "u2" },
      data: { paymentId: "pay_1" },
    });
  });
});

describe("every creation path records the participant edge (#1544 / #1554)", () => {
  const read = (f: string) =>
    fs.readFileSync(path.join(process.cwd(), f), "utf8");
  const writers: Array<[string, RegExp]> = [
    ["lib/payments/operations/checkout.ts", /recordParticipants\(/],
    ["utils/scheduling-engine/SchedulingService.ts", /recordParticipants\(/],
    ["app/api/trials/[trialId]/route.ts", /recordParticipants\(/],
    // #1544 — the one creation path that never wrote the roster until #1554.
    [
      "app/api/scheduling/request-for-approval/route.ts",
      /recordParticipants\(/,
    ],
    [
      "lib/payments/webhooks/handlers.ts",
      /setParticipantStatus\(|participants: \{/,
    ],
    [
      "app/api/participants/webinar/[webinarId]/route.ts",
      /releaseParticipant\(/,
    ],
    ["app/api/participants/class/[classId]/route.ts", /releaseParticipant\(/],
    ["lib/payments/operations/cancel-pending.ts", /releaseParticipant\(/],
    [
      "app/api/appointments/[appointmentId]/cancel/route.ts",
      /setParticipantStatus\(/,
    ],
    ["lib/trials/cancellation.ts", /setParticipantStatus\(/],
    ["lib/payments/operations/booking-refund.ts", /setParticipantStatus\(/],
    ["prisma/seedFiles/6a-create-appointments.ts", /participants: \{/],
    [
      "scripts/appointments/reconcile-occurrence-availability.ts",
      /participant_drift/,
    ],
  ];
  it.each(writers)("%s", (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  it("checkout records participants once per handler that seats a buyer", () => {
    const src = read("lib/payments/operations/checkout.ts");
    expect((src.match(/recordParticipants\(/g) ?? []).length).toBe(4);
  });
});
