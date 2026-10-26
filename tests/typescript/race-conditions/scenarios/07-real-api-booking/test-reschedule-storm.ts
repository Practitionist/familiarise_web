/**
 * Test: Reschedule Storm (N concurrent reschedules of one appointment)
 * Category: 07 - Real API booking races (#837 scenario 10)
 *
 * Ten concurrent reschedules of a harness-owned appointment. Reschedule is
 * re-entrant (PENDING is itself reschedulable), so multiple winners are
 * legal — the invariants are: zero 5xx, terminal slots never resurrected,
 * and the appointment ends in a single coherent state (PENDING + all live
 * slots tentative).
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import {
  apiFetch,
  check,
  finish,
  fireConcurrent,
  histogram,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

async function run() {
  await ensureServerOrSkip();

  // Own fixture: a PENDING consultation with one tentative slot far in the
  // future, so the storm never shares or consumes the seeded pool.
  const plan = await prisma.consultationPlan.findFirst({
    where: { status: "PUBLISHED" },
    select: { id: true, consultantProfileId: true },
  });
  const consultee = await prisma.consulteeProfile.findFirst({
    select: { id: true },
  });
  if (!plan || !consultee) {
    console.log(
      "⏭️  SKIP — no published consultation plan or consultee in seed data",
    );
    process.exit(0);
  }
  const startsAt = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  startsAt.setUTCHours(3, 0, 0, 0);
  const created = await prisma.consultation.create({
    data: {
      consultationPlanId: plan.id,
      requestedById: consultee.id,
      status: "PENDING",
      appointment: {
        create: {
          appointmentType: "CONSULTATION",
          occurrences: {
            create: {
              ordinal: 1,
              startsAt,
              endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
              isTentative: true,
              completionStatus: "SCHEDULED",
              consultantProfileId: plan.consultantProfileId,
            },
          },
        },
      },
    },
    select: { id: true, appointment: { select: { id: true } } },
  });
  const appointment = {
    id: created.appointment!.id,
    consultation: { id: created.id },
  };

  try {
    const terminalBefore = await prisma.appointmentOccurrence.count({
      where: {
        appointmentId: appointment.id,
        completionStatus: { in: ["COMPLETED", "CANCELLED", "UNVERIFIED"] },
      },
    });

    const admin = await loginAs(
      process.env.CHAOS_ADMIN_EMAIL ?? "qa-admin-1@qa.familiarise.invalid",
    );

    const results = await fireConcurrent(10, () =>
      apiFetch(
        `/api/appointments/${appointment.id}/reschedule?type=CONSULTATION`,
        {
          method: "POST",
          session: admin,
          body: JSON.stringify({}),
        },
      ),
    );

    const h = histogram(results);
    const serverErrors = results.filter((r) => r.status >= 500).length;
    check("reschedule storm: zero 5xx", serverErrors === 0, h);

    const consultation = await prisma.consultation.findUnique({
      where: { id: appointment.consultation.id },
      select: { status: true },
    });
    check(
      "appointment ends in a single coherent state (PENDING)",
      consultation?.status === "PENDING",
      consultation,
    );

    const terminalAfter = await prisma.appointmentOccurrence.count({
      where: {
        appointmentId: appointment.id,
        completionStatus: { in: ["COMPLETED", "CANCELLED", "UNVERIFIED"] },
      },
    });
    check(
      "terminal slots never resurrected",
      terminalAfter === terminalBefore,
      {
        terminalBefore,
        terminalAfter,
      },
    );
  } finally {
    // Retire the fixture; the appointment and its slots cascade with it.
    // BookingStatusHistory is append-only and stays.
    await prisma.consultation.delete({
      where: { id: appointment.consultation.id },
    });
  }

  finish("reschedule-storm");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
