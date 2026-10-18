/**
 * Test: Approve vs Decline Race on a Pending Consultation (#836)
 * Category: 07 - Real API booking races (#837 scenario 11)
 *
 * A consultant approves while the same request is concurrently declined
 * (two tabs / two staff members). Serial approve-then-reject is a legal
 * interleaving ({200,200}); the invariant is the final state: every 2xx is
 * exactly one recorded transition, the chain is legal, and nothing doubles.
 */
import "dotenv/config";
import prisma from "../../../../../lib/prisma";
import { REQUEST_ALLOWED_FROM } from "../../../../../lib/booking/transitions";
import {
  apiFetch,
  check,
  finish,
  histogram,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

const allowedFrom = new Map<string, string[]>(
  Object.entries(REQUEST_ALLOWED_FROM),
);

async function run() {
  await ensureServerOrSkip();

  const pending = await prisma.consultation.findFirst({
    where: { status: "PENDING" },
    select: { id: true, appointment: { select: { id: true } } },
  });
  if (!pending) {
    console.log("⏭️  SKIP — no PENDING consultation in seed data");
    process.exit(0);
  }

  const admin = await loginAs(
    process.env.CHAOS_ADMIN_EMAIL ?? "olivia.brown@protonmail.com",
  );

  const testStart = new Date();
  const results = await Promise.all([
    apiFetch(`/api/bookings/consultations/${pending.id}`, {
      method: "PATCH",
      session: admin,
      body: JSON.stringify({ status: "APPROVED" }),
    }),
    apiFetch(`/api/bookings/consultations/${pending.id}`, {
      method: "PATCH",
      session: admin,
      body: JSON.stringify({ status: "REJECTED" }),
    }),
  ]);

  check(
    "no server errors",
    results.every((r) => r.status < 500),
    histogram(results),
  );
  const winners = results.filter((r) => r.status >= 200 && r.status < 300);
  check(
    "at least one request is applied",
    winners.length >= 1,
    histogram(results),
  );

  const after = await prisma.consultation.findUnique({
    where: { id: pending.id },
    select: { status: true },
  });
  const history = await prisma.bookingStatusHistory.findMany({
    where: {
      entity: "CONSULTATION",
      entityId: pending.id,
      createdAt: { gte: testStart },
    },
    orderBy: { createdAt: "asc" },
    select: { fromStatus: true, toStatus: true },
  });

  // The request that returned 2xx must be the one whose target was recorded.
  const targets = [["APPROVED", "APPROVED_PENDING_PAYMENT"], ["REJECTED"]];
  check(
    "each 2xx matches a recorded transition to its requested status",
    results.every(
      (r, i) =>
        r.status < 200 ||
        r.status >= 300 ||
        history.some((h) => targets[i].includes(h.toStatus)),
    ),
    { history, statuses: results.map((r) => r.status) },
  );
  check(
    "each 2xx is exactly one recorded transition",
    history.length === winners.length,
    { history, winners: winners.length },
  );
  const legalChain = history.every((h, i) => {
    const allowed = allowedFrom.get(h.toStatus) ?? [];
    const linked =
      i === 0
        ? h.fromStatus === "PENDING"
        : h.fromStatus === history[i - 1].toStatus;
    return linked && allowed.includes(h.fromStatus);
  });
  check("transitions form a legal chain from PENDING", legalChain, history);
  check(
    "final status is the last recorded transition and is not PENDING",
    history.length > 0 &&
      after?.status === history[history.length - 1].toStatus &&
      after?.status !== "PENDING",
    { after, history },
  );

  const payments = pending.appointment
    ? await prisma.payment.findMany({
        where: {
          appointmentId: pending.appointment.id,
          createdAt: { gte: testStart },
        },
        select: { paymentStatus: true },
      })
    : [];
  check(
    "at most one payment minted, and a rejected request leaves none PENDING",
    payments.length <= 1 &&
      !(
        after?.status === "REJECTED" &&
        payments.some((p) => p.paymentStatus === "PENDING")
      ),
    { payments, status: after?.status },
  );

  // Restore the fixture for repeat runs.
  await prisma.consultation.update({
    where: { id: pending.id },
    data: { status: "PENDING", pendingPaymentUrl: null },
  });

  finish("approve-decline-race");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
