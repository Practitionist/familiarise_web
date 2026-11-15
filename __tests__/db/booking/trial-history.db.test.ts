/**
 * A pair keeps every trial against real Postgres: a request after a cancelled
 * trial adds a row and leaves the earlier one as it was, and the partial
 * unique index refuses a second live or delivered trial, including when two
 * requests race, with the error the request door maps to its 409.
 */
import { TrialStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { transitionTrial } from "../../../lib/booking/transitions";
import { isUniqueViolationOn } from "../../../lib/db/unique-violation";
import { bookTrialInTx } from "../../../lib/trials/book-trial";
import {
  TRIAL_PAIR_BLOCKING_INDEX,
  TRIAL_REQUEST_BLOCKING_STATUSES,
} from "../../../lib/trials/eligibility";
import { futureAt, seedHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

async function seedPair() {
  const host = await seedHost();
  await publishEveryHour(host);
  const buyer = await seedBuyer();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Trial history plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      trialEnabled: true,
      trialDurationMinutes: 30,
      trialPriceInPaise: BigInt(0),
    },
  });
  return { host, buyer, plan };
}

type Pair = Awaited<ReturnType<typeof seedPair>>;

/** The request door's own insert: a free trial confirmed at the picked time. */
function book({ host, buyer, plan }: Pair, startsAt: Date) {
  return prisma.$transaction((tx) =>
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
}

describe("trial history per pair (real Postgres)", () => {
  it("a request after a cancelled trial adds a row and leaves the first one untouched", async () => {
    const pair = await seedPair();
    const first = await book(pair, futureAt(3, 10));
    await prisma.$transaction((tx) =>
      transitionTrial(tx, {
        where: { id: first.id },
        to: TrialStatus.CANCELLED,
      }),
    );
    const before = await prisma.trial.findUniqueOrThrow({
      where: { id: first.id },
    });

    const second = await book(pair, futureAt(4, 10));

    const rows = await prisma.trial.findMany({
      where: { consulteeProfileId: pair.buyer.consulteeProfileId },
      orderBy: { requestedAt: "asc" },
    });
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first.id, TrialStatus.CANCELLED],
      [second.id, TrialStatus.SCHEDULED],
    ]);
    expect(rows[0]).toEqual(before);
    expect(rows[0].appointmentId).toBe(first.appointmentId);
    expect(second.appointmentId).not.toBe(first.appointmentId);
  });

  it("two racing requests for one pair leave one live trial; the loser carries the index the route maps", async () => {
    const pair = await seedPair();

    const results = await Promise.allSettled([
      book(pair, futureAt(5, 10)),
      book(pair, futureAt(6, 10)),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      isUniqueViolationOn(
        (rejected[0] as PromiseRejectedResult).reason,
        TRIAL_PAIR_BLOCKING_INDEX,
      ),
    ).toBe(true);
    expect(
      await prisma.trial.count({
        where: { consulteeProfileId: pair.buyer.consulteeProfileId },
      }),
    ).toBe(1);
  });

  it.each(Object.values(TrialStatus))(
    "an earlier %s trial blocks a second live one exactly when the request door says so",
    async (status) => {
      const { host, buyer, plan } = await seedPair();
      const row = (s: TrialStatus) =>
        prisma.trial.create({
          data: {
            consulteeProfileId: buyer.consulteeProfileId,
            consultantProfileId: host.consultantProfileId,
            subscriptionPlanId: plan.id,
            status: s,
          },
        });
      await row(status);

      const outcome = await row(TrialStatus.SCHEDULED).then(
        () => "created",
        (error: unknown) =>
          isUniqueViolationOn(error, TRIAL_PAIR_BLOCKING_INDEX)
            ? "refused by the pair index"
            : error,
      );

      expect(outcome).toBe(
        TRIAL_REQUEST_BLOCKING_STATUSES.includes(status)
          ? "refused by the pair index"
          : "created",
      );
    },
  );
});
