/**
 * Dual-role and org-actor surfaces on real Postgres:
 *  - an expert's own sessions as a client show on their Home as read-only
 *    "Booked as a client" rows linking to the learner facet;
 *  - org money paying one of the org's own OWNERs is a related-party booking:
 *    one audit row at commit and a flag on the org's appointment list.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { getConsultantDashboard } from "../../../lib/data/consultant-dashboard";
import { listAppointmentsScoped } from "../../../lib/api/scope/list-appointments";
import { recordRelatedPartyBooking } from "../../../lib/enterprise/related-party";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedDualRole,
  seedHost,
  seedOneToOne,
} from "../booking/harness";
import { seedWebinar } from "../booking/harness-seats";

it("lists an expert's own client bookings on their Home, read-only, linked to the learner facet", async () => {
  const dual = await seedDualRole();
  await prisma.user.update({
    where: { id: dual.userId },
    data: { consulteeProfileId: dual.consulteeProfileId },
  });
  const other = await seedHost();
  const startsAt = futureAt(3, 11);
  const booked = await seedOneToOne(
    "consultation",
    other,
    dual,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    { status: "APPROVED", isTentative: false },
  );
  // Their own delivered session is NOT a client booking.
  const learner = await seedConsultee();
  const ownStart = futureAt(3, 14);
  await seedOneToOne(
    "consultation",
    dual,
    learner,
    { startsAt: ownStart, endsAt: new Date(ownStart.getTime() + HOUR_MS) },
    { status: "APPROVED", isTentative: false },
  );

  const home = await getConsultantDashboard(dual.consultantProfileId);
  expect(home.clientBookings).toEqual([
    expect.objectContaining({
      appointmentId: booked.appointmentId,
      href: `/dashboard/consultee/${dual.consulteeProfileId}/appointments/${booked.appointmentId}`,
    }),
  ]);
});

describe("related-party bookings", () => {
  async function seedOrgWithOwner(ownerUserId: string) {
    const id = randomUUID();
    const org = await prisma.organization.create({
      data: {
        name: `Org ${id.slice(0, 6)}`,
        slug: `org-${id}`,
        status: "ACTIVE",
      },
    });
    const owner = await prisma.membership.create({
      data: {
        userId: ownerUserId,
        organizationId: org.id,
        role: "OWNER",
        status: "ACTIVE",
      },
    });
    return { org, owner };
  }

  it("writes one audit row when the expert owns the paying org, none otherwise", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const { org, owner } = await seedOrgWithOwner(expert.userId);
    const startsAt = futureAt(4, 10);
    const booking = await seedOneToOne(
      "consultation",
      expert,
      learner,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      { status: "APPROVED", isTentative: false },
    );
    const stranger = await seedHost();
    const strangerPlan = await prisma.consultationPlan.create({
      data: {
        title: "Not related",
        price: BigInt(100_000),
        consultantProfileId: stranger.consultantProfileId,
      },
    });

    await prisma.$transaction(async (tx) => {
      await recordRelatedPartyBooking(tx, {
        organizationId: org.id,
        planKind: "CONSULTATION",
        planId: booking.planId,
        paymentId: "pay-related",
        appointmentId: booking.appointmentId,
        buyerMembershipId: null,
      });
      await recordRelatedPartyBooking(tx, {
        organizationId: org.id,
        planKind: "CONSULTATION",
        planId: strangerPlan.id,
        paymentId: "pay-unrelated",
        appointmentId: null,
        buyerMembershipId: null,
      });
    });

    const rows = await prisma.orgAuditLog.findMany({
      where: { organizationId: org.id, action: "RELATED_PARTY_BOOKING" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].targetMembershipId).toBe(owner.id);
    expect(rows[0].details).toMatchObject({
      relatedParty: true,
      paymentId: "pay-related",
    });
  });

  it("flags only org-funded rows an owner delivered", async () => {
    const owner = await seedHost();
    const other = await seedHost();
    const learner = await seedConsultee();
    const { org } = await seedOrgWithOwner(owner.userId);
    const mk = async (host: typeof owner, hour: number, funded: boolean) => {
      const startsAt = futureAt(6, hour);
      const b = await seedOneToOne(
        "consultation",
        host,
        learner,
        { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
        { status: "PENDING", isTentative: true },
      );
      await prisma.appointment.update({
        where: { id: b.appointmentId },
        data: { organizationId: org.id },
      });
      if (funded) {
        await prisma.payment.create({
          data: {
            amount: BigInt(100_000),
            originalAmount: BigInt(100_000),
            paymentMethod: "WALLET",
            paymentIntent: `org_dbtier_${randomUUID()}`,
            paymentGateway: "RAZORPAY",
            paymentStatus: "SUCCEEDED",
            userId: learner.userId,
            appointmentId: b.appointmentId,
            organizationId: org.id,
            isMockPayment: true,
            legs: {
              create: [{ source: "WALLET", amountPaise: BigInt(100_000) }],
            },
          },
        });
      }
      return b.appointmentId;
    };
    const ownerFunded = await mk(owner, 9, true);
    const ownerUnpaid = await mk(owner, 11, false);
    const otherFunded = await mk(other, 13, true);

    const { items } = await listAppointmentsScoped({
      scope: { kind: "org", orgId: org.id },
      userId: "",
    });
    const flags = Object.fromEntries(
      items.map((i) => [i.id, (i as { relatedParty?: boolean }).relatedParty]),
    );
    expect(flags).toEqual({
      [ownerFunded]: true,
      [ownerUnpaid]: false,
      [otherFunded]: false,
    });
  });

  it("audits an owner who is an ACCEPTED co-host of the funded event", async () => {
    const coHost = await seedHost();
    const { org, owner } = await seedOrgWithOwner(coHost.userId);
    const webinar = await seedWebinar({ capacity: 5 });
    // A collaboration is born an invitation; the accept is its own write.
    const invitation = await prisma.collaborator.create({
      data: {
        consultantProfileId: coHost.consultantProfileId,
        collaboratorType: "WEBINAR",
        webinarPlanId: webinar.planId,
        role: "CO_HOST",
        tier: "PRESENTER",
        revenueShareBps: 2000,
      },
    });
    await prisma.collaborator.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    });
    await prisma.$transaction((tx) =>
      recordRelatedPartyBooking(tx, {
        organizationId: org.id,
        planKind: "WEBINAR",
        planId: webinar.planId,
        paymentId: "pay-cohost",
        appointmentId: webinar.appointmentId,
        buyerMembershipId: null,
      }),
    );
    const rows = await prisma.orgAuditLog.findMany({
      where: { organizationId: org.id, action: "RELATED_PARTY_BOOKING" },
    });
    expect(rows.map((r) => r.targetMembershipId)).toEqual([owner.id]);
  });
});
