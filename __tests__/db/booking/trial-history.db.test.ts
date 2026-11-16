/**
 * Cancelled trials keep their history; one live or delivered trial holds the pair.
 */
import { TrialStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { transitionTrial } from "../../../lib/booking/transitions";
import { isUniqueViolationOn } from "../../../lib/db/unique-violation";
import {
  bookTrialInTx,
  TrialPairHeldError,
} from "../../../lib/trials/book-trial";
import {
  TRIAL_PAIR_BLOCKING_INDEX,
  TRIAL_REQUEST_BLOCKING_STATUSES,
} from "../../../lib/trials/eligibility";
import { futureAt, seedHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

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

/** Names the pair guard that refused; any other error is returned unchanged. */
function refusal(error: unknown): unknown {
  if (error instanceof TrialPairHeldError) return "in-transaction recheck";
  if (isUniqueViolationOn(error, TRIAL_PAIR_BLOCKING_INDEX))
    return "pair index";
  return error;
}

function rejections(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
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
    // The client stamps each row with a symbol-keyed inspector; compare the columns.
    expect(Object.fromEntries(Object.entries(rows[0]))).toEqual(
      Object.fromEntries(Object.entries(before)),
    );
    expect(rows[0].appointmentId).toBe(first.appointmentId);
    expect(second.appointmentId).not.toBe(first.appointmentId);
  });

  it("two racing requests for one pair leave one live trial, the loser refused by either pair guard", async () => {
    const pair = await seedPair();

    const results = await Promise.allSettled([
      book(pair, futureAt(5, 10)),
      book(pair, futureAt(6, 10)),
    ]);

    const losers = rejections(results).map(refusal);
    expect(losers).toHaveLength(1);
    expect(["in-transaction recheck", "pair index"]).toContain(losers[0]);
    expect(
      await prisma.trial.count({
        where: { consulteeProfileId: pair.buyer.consulteeProfileId },
      }),
    ).toBe(1);
  });

  it("two competing inserts for one pair: the index refuses the second with the error the route maps", async () => {
    const { host, buyer, plan } = await seedPair();
    const insert = () =>
      prisma.trial.create({
        data: {
          consulteeProfileId: buyer.consulteeProfileId,
          consultantProfileId: host.consultantProfileId,
          subscriptionPlanId: plan.id,
          status: TrialStatus.SCHEDULED,
        },
      });

    const results = await Promise.allSettled([insert(), insert()]);

    expect(rejections(results).map(refusal)).toEqual(["pair index"]);
  });

  it("refuses a second blocking trial inside the booking transaction even without the pair index", async () => {
    const pair = await seedPair();
    await book(pair, futureAt(7, 10));
    const rollback = new Error("rollback");

    // DDL is transactional: the dropped index is back once this transaction rolls back.
    const outcome = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX "${TRIAL_PAIR_BLOCKING_INDEX}"`);
        await bookTrialInTx(tx, {
          consulteeProfileId: pair.buyer.consulteeProfileId,
          consultantProfileId: pair.host.consultantProfileId,
          subscriptionPlanId: pair.plan.id,
          organizationId: null,
          consulteeUserId: pair.buyer.userId,
          consultantUserId: pair.host.userId,
          paid: false,
          agreedPricePaise: 0,
          startsAt: futureAt(8, 10),
          endsAt: futureAt(8, 10, 30),
        });
        throw rollback;
      })
      .catch((error: unknown) =>
        error === rollback ? "created" : refusal(error),
      );

    expect(outcome).toBe("in-transaction recheck");
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
