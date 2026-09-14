/**
 * Test: Last-Seat Enrollment Storm (write-path scale hardening)
 * Category: 07 - Real API booking races
 *
 * N users race concurrent checkouts for a webinar with exactly ONE free
 * seat. The guard under test is the per-event checkout lock + the
 * tentative-inclusive participant count in validateEventCapacity — verified
 * in review to serialize the check-then-hold, this scenario pins that as a
 * regression test. Invariants: exactly one winner, losers get a clean 4xx
 * ("Webinar is full"), zero 5xx, and the confirmed participant count never
 * exceeds maxParticipants.
 *
 * Uses mock payments (dev-only flag) so winners confirm instantly and the
 * capacity math is synchronous.
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import { liveParticipant } from "../../../../../lib/booking/participants";
import {
  apiFetch,
  check,
  finish,
  histogram,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";
import { countWebinarParticipants } from "../../../../../lib/payments/utils/participants";

const STORM_SIZE = 3;

async function run() {
  await ensureServerOrSkip();

  // Fixture: a webinar with an appointment and a plan we can shrink to
  // exactly one free seat.
  const webinar = await prisma.webinar.findFirst({
    where: { appointment: { isNot: null }, status: "SCHEDULED" },
    include: {
      webinarPlan: {
        include: { consultantProfile: { select: { userId: true } } },
      },
      appointment: {
        include: {
          participants: {
            where: liveParticipant(),
            select: { userId: true },
          },
        },
      },
    },
  });
  if (!webinar?.appointment) {
    console.log("⏭️  SKIP — no scheduled webinar with an appointment in seed data");
    process.exit(0);
  }

  const consultantUserId = webinar.webinarPlan.consultantProfile?.userId;
  const enrolledUserIds = new Set<string>(
    webinar.appointment.participants.map((seat) => seat.userId),
  );
  const currentParticipants = countWebinarParticipants(webinar.appointment, [
    consultantUserId || "",
  ]);

  // Stormers: consultees not already enrolled.
  const stormers = await prisma.user.findMany({
    where: {
      role: "CONSULTEE",
      id: { notIn: Array.from(enrolledUserIds) },
      consulteeProfile: { isNot: null },
    },
    select: { id: true, email: true },
    take: STORM_SIZE,
  });
  if (stormers.length < STORM_SIZE) {
    console.log("⏭️  SKIP — not enough unenrolled consultees in seed data");
    process.exit(0);
  }

  // Arm: exactly one free seat.
  const originalMax = webinar.webinarPlan.maxParticipants;
  await prisma.webinarPlan.update({
    where: { id: webinar.webinarPlan.id },
    data: { maxParticipants: currentParticipants + 1 },
  });

  const testStart = new Date();
  try {
    const sessions = [];
    for (const s of stormers) {
      sessions.push(await loginAs(s.email!));
    }

    const results = await Promise.all(
      sessions.map((session) =>
        apiFetch(`/api/checkout`, {
          method: "POST",
          session,
          body: JSON.stringify({
            appointmentType: "WEBINAR",
            planId: webinar.webinarPlanId,
            eventId: webinar.id,
            paymentGateway: "RAZORPAY",
            isMockPayment: true,
          }),
        }),
      ),
    );

    const winners = results.filter((r) => r.status >= 200 && r.status < 300);
    const losers = results.filter((r) => !(r.status >= 200 && r.status < 300));
    const serverErrors = results.filter((r) => r.status >= 500);

    check("no server errors", serverErrors.length === 0, histogram(results));
    check(
      "exactly one winner for the last seat",
      winners.length === 1,
      histogram(results),
    );
    check(
      "losers get clean client errors (4xx)",
      losers.every((r) => r.status >= 400 && r.status < 500),
      histogram(results),
    );

    // Capacity invariant straight from the DB.
    const after = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinar.id },
      include: {
        webinarPlan: true,
        appointment: {
        include: {
          participants: {
            where: liveParticipant(),
            select: { userId: true },
          },
        },
        },
      },
    });
    const afterCount = countWebinarParticipants(after.appointment, [
      consultantUserId || "",
    ]);
    check(
      "participants never exceed maxParticipants",
      afterCount <= after.webinarPlan.maxParticipants,
      { afterCount, max: after.webinarPlan.maxParticipants },
    );
  } finally {
    // Restore: plan capacity, the winner's enrollment + payment rows.
    await prisma.webinarPlan.update({
      where: { id: webinar.webinarPlan.id },
      data: { maxParticipants: originalMax },
    });
    const stormerIds = stormers.map((s) => s.id);
    const createdPayments = await prisma.payment.findMany({
      where: {
        userId: { in: stormerIds },
        createdAt: { gte: testStart },
        appointment: { webinarId: webinar.id },
      },
      select: { id: true },
    });
    const paymentIds = createdPayments.map((p) => p.id);
    // Financial children Restrict the payment (#781 §B) — a mock checkout
    // mints earnings/utilization rows that must go first. The whole phase is
    // fenced so a failure here can never abort the slot/enrollment cleanup
    // below (occupancy is slot-based; a leftover payment is inert).
    try {
      await prisma.consultantEarnings.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
      await prisma.organizationEarnings.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
      await prisma.bookingUtilization.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
      await prisma.paymentLeg.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
    } catch (e) {
      console.warn(
        `⚠️ payment cleanup incomplete — rows left in place: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      );
    }
    // Release any stormer's seat (winner or tentative residue) so reruns
    // start from the same occupancy (#1554: the seat is the participant row).
    await prisma.appointmentParticipant.deleteMany({
      where: {
        appointmentId: webinar.appointment.id,
        userId: { in: stormerIds },
        createdAt: { gte: testStart },
      },
    });
  }

  finish("last-seat-storm");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
