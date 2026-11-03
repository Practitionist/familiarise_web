/**
 * Organisation scoping on real Postgres:
 *  - a consultant's personal work is every booking on a plan no org hosts,
 *    sponsor-tagged or not; org-hosted work is the host org's, never another
 *    tenant's;
 *  - an org owns a tagged booking only on a ground (unpaid, its own money, its
 *    own plan) and only while readable: SUSPENDED reads, DEACTIVATED does not;
 *  - a webinar attendee sees their seat on the personal list;
 *  - the org-party support grant uses the same ownership predicate.
 */
import { randomUUID } from "node:crypto";
import type { OrgStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import {
  buildWhere,
  orgOwnedAppointmentWhere,
} from "../../../lib/api/scope/list-appointments";
import { pendingConsultationWhere } from "../../../lib/data/needs-you";
import { readOrgPendingRequests } from "../../../lib/data/org-pending-requests";
import { readConsultantNeedsYou } from "../../../lib/data/consultant-needs-you";
import { listDocumentsScoped } from "../../../lib/api/scope/list-documents";
import type { Scope } from "../../../lib/api/scope/parse";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  type SeededConsultee,
  type SeededHost,
} from "../booking/harness";
import { seedHeldSeat, seedWebinar } from "../booking/harness-seats";

async function seedOrg(status: OrgStatus, canHost = false) {
  const id = randomUUID();
  return prisma.organization.create({
    data: { name: `Org ${id.slice(0, 6)}`, slug: `org-${id}`, status, canHost },
  });
}

let nextHour = 0;

/** A PENDING request on `host`'s plan (hosted by `hostOrgId`), tagged `tagOrgId`. */
async function seedRequest(
  host: SeededHost,
  learner: SeededConsultee,
  args: {
    hostOrgId: string | null;
    tagOrgId: string | null;
    status?: "PENDING" | "APPROVED";
    payment?: { method: string; source: "CARD" | "WALLET"; orgId?: string };
  },
) {
  const plan = await prisma.consultationPlan.create({
    data: {
      title: `Scope ${randomUUID().slice(0, 6)}`,
      price: BigInt(100_000),
      consultantProfileId: host.consultantProfileId,
      organizationId: args.hostOrgId,
      durationInHours: 1,
    },
  });
  const consultation = await prisma.consultation.create({
    data: {
      consultationPlanId: plan.id,
      requestedById: learner.consulteeProfileId,
      status: args.status ?? "PENDING",
      bookingSource: "REQUEST_SUBMITTED",
    },
  });
  const appointment = await prisma.appointment.create({
    data: {
      appointmentType: "CONSULTATION",
      consultationId: consultation.id,
      organizationId: args.tagOrgId,
    },
  });
  // Each row its own hour: confirmed rows of one host may not overlap.
  const startsAt = futureAt(5 + Math.floor(nextHour / 12), 8 + (nextHour % 12));
  nextHour += 1;
  await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: appointment.id,
      ordinal: 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
      isTentative: (args.status ?? "PENDING") === "PENDING",
      consultantProfileId: host.consultantProfileId,
    },
  });
  if (args.payment) {
    await prisma.payment.create({
      data: {
        amount: BigInt(100_000),
        originalAmount: BigInt(100_000),
        paymentMethod: args.payment.method,
        paymentIntent: `org_dbtier_${randomUUID()}`,
        paymentGateway: "RAZORPAY",
        paymentStatus: "SUCCEEDED",
        userId: learner.userId,
        appointmentId: appointment.id,
        organizationId: args.payment.orgId ?? null,
        isMockPayment: true,
        legs: {
          create: [
            { source: args.payment.source, amountPaise: BigInt(100_000) },
          ],
        },
      },
    });
  }
  return { consultationId: consultation.id, appointmentId: appointment.id };
}

const consultationIds = async (cp: string, scope: Scope) =>
  (
    await prisma.consultation.findMany({
      where: pendingConsultationWhere(cp, scope),
      select: { id: true },
    })
  )
    .map((c) => c.id)
    .sort();

const appointmentIds = async (where: object, among: string[]) =>
  (
    await prisma.appointment.findMany({
      where: { AND: [where, { id: { in: among } }] },
      select: { id: true },
    })
  )
    .map((a) => a.id)
    .sort();

const sorted = (...ids: string[]) => [...ids].sort();

describe("consultant delivery splits on the plan's host org", () => {
  it("lists sponsor-tagged requests on personal plans as personal, org-hosted ones under the host org only", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const hostOrg = await seedOrg("ACTIVE", true);
    const sponsor = await seedOrg("ACTIVE");
    const sponsored = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: sponsor.id,
    });
    const plain = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: null,
    });
    const hosted = await seedRequest(expert, learner, {
      hostOrgId: hostOrg.id,
      tagOrgId: hostOrg.id,
    });
    const cp = expert.consultantProfileId;

    expect(await consultationIds(cp, { kind: "personal" })).toEqual(
      sorted(sponsored.consultationId, plain.consultationId),
    );
    expect(
      await consultationIds(cp, { kind: "org", orgId: hostOrg.id }),
    ).toEqual([hosted.consultationId]);
    // Cross-tenant: the sponsor tag never puts the expert's work in the sponsor's queue.
    expect(
      await consultationIds(cp, { kind: "org", orgId: sponsor.id }),
    ).toEqual([]);

    const all = [
      sponsored.appointmentId,
      plain.appointmentId,
      hosted.appointmentId,
    ];
    expect(
      await appointmentIds(
        buildWhere({ scope: { kind: "personal" }, userId: expert.userId }),
        all,
      ),
    ).toEqual(sorted(sponsored.appointmentId, plain.appointmentId));
    expect(
      await appointmentIds(
        buildWhere({
          scope: {
            kind: "orgMember",
            orgId: hostOrg.id,
            userId: expert.userId,
          },
          userId: expert.userId,
        }),
        all,
      ),
    ).toEqual([hosted.appointmentId]);
    // The learner still sees the sponsored booking on the sponsor's member view, not personal.
    expect(
      await appointmentIds(
        buildWhere({ scope: { kind: "personal" }, userId: learner.userId }),
        all,
      ),
    ).toEqual(sorted(plain.appointmentId));
    expect(
      await appointmentIds(
        buildWhere({
          scope: {
            kind: "orgMember",
            orgId: sponsor.id,
            userId: learner.userId,
          },
          userId: learner.userId,
        }),
        all,
      ),
    ).toEqual([sponsored.appointmentId]);
  });

  it("routes a learner's reschedule reply to the expert's personal Needs-you by plan host", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const hostOrg = await seedOrg("ACTIVE", true);
    const sponsor = await seedOrg("ACTIVE");
    const sponsored = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: sponsor.id,
      status: "APPROVED",
    });
    const hosted = await seedRequest(expert, learner, {
      hostOrgId: hostOrg.id,
      tagOrgId: null,
      status: "APPROVED",
    });
    for (const appointmentId of [
      sponsored.appointmentId,
      hosted.appointmentId,
    ]) {
      await prisma.rescheduleRequest.create({
        data: {
          appointmentId,
          initiatorRole: "CONSULTEE",
          initiatedById: learner.userId,
          expiresAt: new Date(Date.now() + 24 * HOUR_MS),
        },
      });
    }
    const needsYou = await readConsultantNeedsYou(expert.consultantProfileId);
    expect(needsYou.rescheduleReplies.map((r) => r.appointmentId)).toEqual([
      sponsored.appointmentId,
    ]);
  });

  it("splits a scheduled trial on its plan's host org, like its request", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const hostOrg = await seedOrg("ACTIVE", true);
    const trialOn = async (hostOrgId: string | null) => {
      const plan = await prisma.subscriptionPlan.create({
        data: {
          title: `Trial ${randomUUID().slice(0, 6)}`,
          price: BigInt(100_000),
          consultantProfileId: expert.consultantProfileId,
          organizationId: hostOrgId,
        },
      });
      const appointment = await prisma.appointment.create({
        data: { appointmentType: "TRIAL" },
      });
      await prisma.trial.create({
        data: {
          consulteeProfileId: learner.consulteeProfileId,
          consultantProfileId: expert.consultantProfileId,
          subscriptionPlanId: plan.id,
          status: "SCHEDULED",
          appointmentId: appointment.id,
        },
      });
      return appointment.id;
    };
    const personal = await trialOn(null);
    // One trial per learner–expert pair: a second learner for the hosted one.
    const hosted = await (async () => {
      const other = await seedConsultee();
      const plan = await prisma.subscriptionPlan.create({
        data: {
          title: "Hosted trial",
          price: BigInt(100_000),
          consultantProfileId: expert.consultantProfileId,
          organizationId: hostOrg.id,
        },
      });
      const appointment = await prisma.appointment.create({
        data: { appointmentType: "TRIAL" },
      });
      await prisma.trial.create({
        data: {
          consulteeProfileId: other.consulteeProfileId,
          consultantProfileId: expert.consultantProfileId,
          subscriptionPlanId: plan.id,
          status: "SCHEDULED",
          appointmentId: appointment.id,
        },
      });
      return appointment.id;
    })();
    const both = [personal, hosted];
    expect(
      await appointmentIds(
        buildWhere({ scope: { kind: "personal" }, userId: expert.userId }),
        both,
      ),
    ).toEqual([personal]);
    expect(
      await appointmentIds(
        buildWhere({
          scope: {
            kind: "orgMember",
            orgId: hostOrg.id,
            userId: expert.userId,
          },
          userId: expert.userId,
        }),
        both,
      ),
    ).toEqual([hosted]);
    // The learner's trial is always personal.
    expect(
      await appointmentIds(
        buildWhere({ scope: { kind: "personal" }, userId: learner.userId }),
        both,
      ),
    ).toEqual([personal]);
  });

  it("puts a webinar attendee's seat on their personal list", async () => {
    const webinar = await seedWebinar({ capacity: 5 });
    const { buyer } = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });
    expect(
      await appointmentIds(
        buildWhere({ scope: { kind: "personal" }, userId: buyer.userId }),
        [webinar.appointmentId],
      ),
    ).toEqual([webinar.appointmentId]);
  });
});

describe("an org owns a tagged booking only on a ground, while readable", () => {
  it("admits unpaid and org-funded rows, refuses a card-paid tag on someone else's plan", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const sponsor = await seedOrg("ACTIVE");
    const other = await seedOrg("ACTIVE");
    const unpaid = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: sponsor.id,
    });
    const funded = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: sponsor.id,
      status: "APPROVED",
      payment: { method: "WALLET", source: "WALLET", orgId: sponsor.id },
    });
    const cardPaid = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: sponsor.id,
      status: "APPROVED",
      payment: { method: "card", source: "CARD" },
    });
    const elsewhere = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: other.id,
    });
    const all = [
      unpaid.appointmentId,
      funded.appointmentId,
      cardPaid.appointmentId,
      elsewhere.appointmentId,
    ];
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(sponsor.id), all),
    ).toEqual(sorted(unpaid.appointmentId, funded.appointmentId));
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(other.id), all),
    ).toEqual([elsewhere.appointmentId]);

    const queue = (await readOrgPendingRequests(sponsor.id)).map((r) => r.id);
    expect(queue).toContain(unpaid.consultationId);
    expect(queue).not.toContain(cardPaid.consultationId);
    expect(queue).not.toContain(elsewhere.consultationId);
  });

  it("keeps a SUSPENDED org readable and drops a DEACTIVATED one", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const suspended = await seedOrg("SUSPENDED");
    const deactivated = await seedOrg("DEACTIVATED");
    const s = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: suspended.id,
    });
    const d = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: deactivated.id,
    });
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(suspended.id), [
        s.appointmentId,
      ]),
    ).toEqual([s.appointmentId]);
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(deactivated.id), [
        d.appointmentId,
      ]),
    ).toEqual([]);
    expect(await readOrgPendingRequests(deactivated.id)).toEqual([]);
  });
});

describe("the host org sees bookings on plans it hosts, whatever the buyer's tag or rail", () => {
  it("lists hosted rows tagged elsewhere or card-paid; another org never sees them", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const host = await seedOrg("ACTIVE", true);
    const sponsor = await seedOrg("ACTIVE");
    const stranger = await seedOrg("ACTIVE");
    const cardPaid = await seedRequest(expert, learner, {
      hostOrgId: host.id,
      tagOrgId: null,
      status: "APPROVED",
      payment: { method: "card", source: "CARD" },
    });
    const sponsorTagged = await seedRequest(expert, learner, {
      hostOrgId: host.id,
      tagOrgId: sponsor.id,
    });
    const all = [cardPaid.appointmentId, sponsorTagged.appointmentId];
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(host.id), all),
    ).toEqual(sorted(...all));
    // The sponsor sees its own unpaid tagged request, never the card-paid one.
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(sponsor.id), all),
    ).toEqual([sponsorTagged.appointmentId]);
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(stranger.id), all),
    ).toEqual([]);
  });

  it("hides a DEACTIVATED host's rows, keeps a SUSPENDED host's", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const suspended = await seedOrg("SUSPENDED", true);
    const deactivated = await seedOrg("DEACTIVATED", true);
    const s = await seedRequest(expert, learner, {
      hostOrgId: suspended.id,
      tagOrgId: null,
    });
    const d = await seedRequest(expert, learner, {
      hostOrgId: deactivated.id,
      tagOrgId: null,
    });
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(suspended.id), [
        s.appointmentId,
      ]),
    ).toEqual([s.appointmentId]);
    expect(
      await appointmentIds(orgOwnedAppointmentWhere(deactivated.id), [
        d.appointmentId,
      ]),
    ).toEqual([]);
  });

  it("lists an org's documents on the same ownership, not the tag alone", async () => {
    const expert = await seedHost();
    const learner = await seedConsultee();
    const org = await seedOrg("ACTIVE", true);
    const tagOnly = await seedRequest(expert, learner, {
      hostOrgId: null,
      tagOrgId: org.id,
      status: "APPROVED",
      payment: { method: "card", source: "CARD" },
    });
    const hosted = await seedRequest(expert, learner, {
      hostOrgId: org.id,
      tagOrgId: null,
    });
    const doc = (appointmentId: string) =>
      prisma.appointmentDocument.create({
        data: {
          appointmentId,
          fileName: `${randomUUID()}.pdf`,
          originalName: "notes.pdf",
          fileSize: 10,
          mimeType: "application/pdf",
          fileUrl: "https://example.invalid/x",
          storagePath: `docs/${randomUUID()}`,
        },
      });
    await doc(tagOnly.appointmentId);
    const hostedDoc = await doc(hosted.appointmentId);
    const { items } = await listDocumentsScoped({
      scope: { kind: "org", orgId: org.id },
      userId: "",
    });
    expect(items.map((d) => d.id)).toEqual([hostedDoc.id]);
  });
});
