/**
 * A trial reschedule through its real doors: each side moves a trial once, at
 * least 24 hours out, to one named window. The consultee's time inside open
 * hours confirms at once and moves the session in place; the consultant's
 * waits for the learner's Accept; a decline restores the original time and
 * costs no move; the second move by the same side is refused with the cap
 * codes.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { bookTrialInTx } from "../../../lib/trials/book-trial";
import { trialProposalAtoms } from "../../../lib/trials/proposal-atoms";
import { HOUR_MS, seedHost, type SeededHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";

const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

import { POST as reschedule } from "../../../app/api/appointments/[appointmentId]/reschedule/route";
import { POST as respond } from "../../../app/api/appointments/[appointmentId]/reschedule/respond/route";

const hoursAhead = (hours: number) =>
  new Date(Math.ceil((Date.now() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS);

const post = (
  handler: typeof reschedule,
  path: string,
  appointmentId: string,
  body: unknown,
) =>
  handler(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}${path}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );

const proposal = (startsAt: Date) => ({
  proposedSlots: trialProposalAtoms(
    startsAt,
    new Date(startsAt.getTime() + 30 * 60_000),
  ),
});

async function scheduledTrial() {
  const host: SeededHost = await seedHost();
  await publishEveryHour(host);
  const buyer = await seedBuyer();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Trial reschedule plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      trialEnabled: true,
      trialDurationMinutes: 30,
    },
  });
  const startsAt = hoursAhead(24 * 5);
  const trial = await prisma.$transaction((tx) =>
    bookTrialInTx(tx, {
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: host.consultantProfileId,
      subscriptionPlanId: plan.id,
      organizationId: null,
      consulteeUserId: buyer.userId,
      consultantUserId: host.userId,
      paid: false,
      agreedPricePaise: 0,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    }),
  );
  const asLearner = () => {
    sessionUser.current = {
      id: buyer.userId,
      role: "CONSULTEE",
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: null,
      name: "Learner",
    };
  };
  const asExpert = () => {
    sessionUser.current = {
      id: host.userId,
      role: "CONSULTANT",
      consulteeProfileId: null,
      consultantProfileId: host.consultantProfileId,
      name: "Expert",
    };
  };
  return { trial, startsAt, asLearner, asExpert };
}

const sessionOf = (appointmentId: string) =>
  prisma.appointmentOccurrence.findFirstOrThrow({
    where: { appointmentId, deletedAt: null },
    select: { startsAt: true, completionStatus: true, isTentative: true },
  });

describe("trial reschedule on the database", () => {
  it("the learner's time in open hours confirms at once; a second learner move is refused", async () => {
    const { trial, asLearner } = await scheduledTrial();
    asLearner();
    const newStart = hoursAhead(24 * 6);
    const res = await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(newStart),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("AUTO_CONFIRMED");
    expect(await sessionOf(trial.appointmentId)).toEqual({
      startsAt: newStart,
      completionStatus: "SCHEDULED",
      isTentative: false,
    });
    const after = await prisma.trial.findUniqueOrThrow({
      where: { id: trial.id },
      select: { status: true },
    });
    expect(after.status).toBe("SCHEDULED");

    const again = await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(hoursAhead(24 * 7)),
    );
    expect(again.status).toBe(422);
    expect((await again.json()).code).toBe("MAX_RESCHEDULES_EXCEEDED");
  });

  it("the expert's time waits for the learner's Accept; a second expert move is refused", async () => {
    const { trial, startsAt, asLearner, asExpert } = await scheduledTrial();
    asExpert();
    const newStart = hoursAhead(24 * 6 + 2);
    const proposed = await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(newStart),
    );
    expect(proposed.status).toBe(200);
    expect((await proposed.json()).outcome).toBe("AWAITING_ANSWER");
    expect(await sessionOf(trial.appointmentId)).toEqual({
      startsAt,
      completionStatus: "RESCHEDULED",
      isTentative: true,
    });

    asLearner();
    const accepted = await post(
      respond,
      "/reschedule/respond",
      trial.appointmentId,
      {
        action: "accept",
      },
    );
    expect(accepted.status).toBe(200);
    expect(await sessionOf(trial.appointmentId)).toEqual({
      startsAt: newStart,
      completionStatus: "SCHEDULED",
      isTentative: false,
    });

    asExpert();
    const again = await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(hoursAhead(24 * 8)),
    );
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("EXPERT_RESCHEDULE_CAP");
  });

  it("a declined move restores the original time and costs the expert nothing", async () => {
    const { trial, startsAt, asLearner, asExpert } = await scheduledTrial();
    asExpert();
    await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(hoursAhead(24 * 6)),
    );
    asLearner();
    const declined = await post(
      respond,
      "/reschedule/respond",
      trial.appointmentId,
      {
        action: "decline",
      },
    );
    expect(declined.status).toBe(200);
    expect((await declined.json()).outcome).toBe("DECLINED");
    expect(await sessionOf(trial.appointmentId)).toEqual({
      startsAt,
      completionStatus: "SCHEDULED",
      isTentative: false,
    });

    asExpert();
    const again = await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(hoursAhead(24 * 6 + 1)),
    );
    expect(again.status).toBe(200);
  });

  it("a session under 24 hours away does not move", async () => {
    const { trial, asLearner } = await scheduledTrial();
    await prisma.appointmentOccurrence.updateMany({
      where: { appointmentId: trial.appointmentId },
      data: {
        startsAt: hoursAhead(10),
        endsAt: new Date(hoursAhead(10).getTime() + 30 * 60_000),
      },
    });
    asLearner();
    const res = await post(
      reschedule,
      "/reschedule",
      trial.appointmentId,
      proposal(hoursAhead(24 * 6)),
    );
    expect(res.status).toBe(409);
  });
});
