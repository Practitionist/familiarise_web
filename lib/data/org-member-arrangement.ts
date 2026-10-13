/**
 * Data layer for /dashboard/organization/[orgId]/compensation (EXPERT per-org
 * view). Server-only reads extracted out of the RSC page (repo convention:
 * lib/data/* for RSC read-fetchers) so the page is a thin renderer and the
 * queries are reusable + testable. #754 / #777 §D.
 *
 * Earnings are read fresh per request — money state is never cached (v2
 * money-safety rule).
 */
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { resolveEffectiveRateCard } from "@/lib/api/organizations/rate-card";
import type { PayoutRecipient } from "@prisma/client";

// #1270 — the shared HOST window (15 min), not the learner's 10. This surface
// is the expert's own per-org view and used to hold a local 10-minute copy, so
// the consultant saw Join appear five minutes later here than on the dashboard
// the page links them to.
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";

/** Where the expert's split comes from, for the Compensation copy. */
function rateCardSource(
  appliedId: string | null,
  overrideId: string | null,
): "platformDefault" | "yours" | "orgDefault" {
  if (appliedId === null) return "platformDefault";
  return appliedId === overrideId ? "yours" : "orgDefault";
}

export async function getMyArrangementData(params: {
  orgId: string;
  payoutRecipient: PayoutRecipient;
  consultantProfileId: string | null;
  rateCardOverrideId: string | null;
}) {
  const { orgId, payoutRecipient, consultantProfileId, rateCardOverrideId } =
    params;
  const now = new Date();
  const nowMs = now.getTime();

  // #1851 owner decision — the expert sees only the split that applies to
  // THEM: their membership override when the org set one, else the org's
  // default card, else the platform default. Same resolver settlement uses,
  // and only the three bps plus when it took effect leave this function; no
  // other expert's card and no card list.
  const resolved = await resolveEffectiveRateCard(prisma, {
    orgId,
    membershipOverrideId: rateCardOverrideId,
    at: now,
  });
  const appliedCard = resolved.rateCardId
    ? await prisma.rateCard.findUnique({
        where: { id: resolved.rateCardId },
        select: { effectiveFrom: true },
      })
    : null;
  const rateCard = {
    platformBps: resolved.platformBps,
    orgBps: resolved.orgBps,
    consultantBps: resolved.consultantBps,
    effectiveFrom: appliedCard?.effectiveFrom ?? null,
    source: rateCardSource(resolved.rateCardId, rateCardOverrideId),
  };

  const payoutAccount =
    payoutRecipient === "ORGANIZATION"
      ? await prisma.organizationPayoutAccount.findUnique({
          where: { organizationId: orgId },
          select: { bankName: true, accountNumberLast4: true, status: true },
        })
      : null;

  // Recent earnings for this consultant on this org's hosted payments. Push the
  // consultantProfileId filter into the organizationEarnings query before
  // take: 20 so other experts' payments in the org cannot crowd out this
  // consultant's recent rows.
  const orgEarningPaymentIds = consultantProfileId
    ? (
        await prisma.organizationEarnings.findMany({
          where: {
            organizationId: orgId,
            payment: {
              earnings: {
                some: { consultantProfileId },
              },
            },
          },
          select: { paymentId: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      ).map((r) => r.paymentId)
    : [];

  const earnings =
    orgEarningPaymentIds.length > 0
      ? await prisma.consultantEarnings.findMany({
          where: {
            consultantProfileId: consultantProfileId!,
            paymentId: { in: orgEarningPaymentIds },
          },
          orderBy: { id: "desc" },
          take: 20,
          include: {
            payment: {
              select: {
                id: true,
                createdAt: true,
                currency: true,
                appointment: {
                  select: {
                    id: true,
                    appointmentType: true,
                    // Sponsorship marker — distinguishes org-sponsored
                    // bookings from direct/personal panel earnings in the
                    // Recent panel earnings table.
                    organizationId: true,
                  },
                },
              },
            },
          },
        })
      : [];

  // #754 — upcoming sessions this expert hosts VIA this org. Appointment is
  // polymorphic, so we match the plan's consultantProfileId on whichever
  // sub-relation applies. Earnings map onto sessions via the shared appointmentId.
  const earningsByAppointmentId = new Map(
    earnings
      .filter((e) => e.payment.appointment?.id)
      .map((e) => [e.payment.appointment!.id, e]),
  );

  const hostedSessions = consultantProfileId
    ? await prisma.appointment.findMany({
        where: {
          organizationId: orgId,
          occurrences: { some: { endsAt: { gte: now } } },
          OR: [
            {
              consultation: {
                consultationPlan: { consultantProfileId },
              },
            },
            {
              subscription: {
                subscriptionPlan: { consultantProfileId },
              },
            },
            { webinar: { webinarPlan: { consultantProfileId } } },
            { class: { classPlan: { consultantProfileId } } },
            { trial: { consultantProfileId } },
          ],
        },
        select: {
          id: true,
          appointmentType: true,
          occurrences: {
            where: { endsAt: { gte: now } },
            orderBy: { startsAt: "asc" },
            take: 1,
            select: {
              startsAt: true,
              endsAt: true,
              isTentative: true,
              completionStatus: true,
            },
          },
          consultation: {
            select: {
              cancelledAt: true,
              requestedBy: { select: { user: { select: { name: true } } } },
            },
          },
          subscription: {
            select: {
              requestedBy: { select: { user: { select: { name: true } } } },
            },
          },
          trial: {
            select: {
              consulteeProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];

  const upcomingSessions = hostedSessions
    .filter(
      (a) => a.occurrences.length > 0 && !a.consultation?.cancelledAt,
    )
    .map((a) => {
      const slot = a.occurrences[0];
      const learner =
        a.consultation?.requestedBy?.user?.name ??
        a.subscription?.requestedBy?.user?.name ??
        a.trial?.consulteeProfile?.user?.name ??
        "—";
      const startMs = new Date(slot.startsAt).getTime();
      const endMs = new Date(slot.endsAt).getTime();
      const joinable =
        !slot.isTentative && nowMs >= startMs - CONSULTANT_JOIN_WINDOW_MS && nowMs <= endMs;
      return {
        id: a.id,
        type: a.appointmentType,
        startsAt: slot.startsAt,
        status: slot.completionStatus,
        learner,
        joinable,
        earning: earningsByAppointmentId.get(a.id) ?? null,
      };
    })
    .sort(
      (x, y) => new Date(x.startsAt).getTime() - new Date(y.startsAt).getTime(),
    );

  // toPlain — rateCard/earnings rows carry an inspect symbol (see serialize.ts)
  return toPlain({ rateCard, payoutAccount, earnings, upcomingSessions });
}
