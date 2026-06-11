/**
 * Test: Cancel vs Reschedule on the Same Appointment (multi-tab race)
 * Category: 07 - Real API booking races (#837 scenario 9)
 *
 * Two tabs act on the same appointment simultaneously: one cancels, one
 * reschedules. Exactly one must win; slots must end consistently
 * (all CANCELLED or all RESCHEDULED-tentative, never mixed).
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import {
  apiFetch,
  assertExactlyOneWinner,
  check,
  finish,
  loginAs,
} from "../../utilities/api-client";

async function run() {
  // Fixture: a consultation appointment in a cancellable state with live slots.
  const appointment = await prisma.appointment.findFirst({
    where: {
      consultation: { requestStatus: { in: ["PENDING", "APPROVED"] } },
      slotsOfAppointment: { some: { completionStatus: "SCHEDULED" } },
    },
    select: { id: true, consultation: { select: { id: true } } },
  });
  if (!appointment) {
    console.log("⏭️  SKIP — no cancellable consultation appointment in seed data");
    process.exit(0);
  }

  const admin = await loginAs(
    process.env.CHAOS_ADMIN_EMAIL ?? "olivia.brown@protonmail.com",
  );

  const results = await Promise.all([
    apiFetch(`/api/appointments/${appointment.id}/cancel`, {
      method: "POST",
      session: admin,
      body: JSON.stringify({}),
    }),
    apiFetch(`/api/appointments/${appointment.id}/reschedule?type=CONSULTATION`, {
      method: "POST",
      session: admin,
      body: JSON.stringify({}),
    }),
  ]);

  assertExactlyOneWinner("cancel-vs-reschedule: exactly one winner", results);

  // Consistency: slots must not be a mix of CANCELLED and RESCHEDULED.
  const slots = await prisma.slotOfAppointment.findMany({
    where: { appointmentId: appointment.id },
    select: { completionStatus: true, isTentative: true },
  });
  const statuses = new Set(slots.map((s) => s.completionStatus));
  check(
    "slots are consistent (no CANCELLED+RESCHEDULED mix)",
    !(statuses.has("CANCELLED") && statuses.has("RESCHEDULED")),
    slots,
  );

  finish("cancel-vs-reschedule-race");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
