/**
 * An expert who is not verified may build and publish plans, but only they see
 * them: the public plan lists, the plan pages, /explore/programs and the
 * organisation member catalog leave them out, each read through its real reader.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { ConsultantVerificationStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "../../../lib/prisma";
import { seedConsultee, seedHost, type SeededHost } from "./harness";

const mockSession = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () =>
    mockSession.current ? { user: mockSession.current } : null,
}));
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: mockSession.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../utils/contentValidation", () =>
  jest.requireActual("../../fixtures/content-validation-stub"),
);
// React 18 exports `cache` only in the RSC build; the detail readers are wrapped in it.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T>(fn: T) => fn,
}));
jest.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
  revalidateTag: jest.fn(),
  revalidatePath: jest.fn(),
}));

import { GET as listConsultationPlans } from "../../../app/api/plans/consultations/route";
import { GET as listSubscriptionPlans } from "../../../app/api/plans/subscriptions/route";
import { GET as listWebinarPlans } from "../../../app/api/plans/webinars/route";
import {
  fetchConsultationPlanDetail,
  fetchSubscriptionPlanDetail,
  fetchWebinarPlanDetail,
} from "../../../lib/data/plan-details";
import { canViewPlanDetail } from "../../../lib/data/plan-viewable";
import {
  getCuratedPrograms,
  getProgramCounts,
} from "../../../lib/data/explore-programs";
import { GET as checkTrialEligibility } from "../../../app/api/trials/check-eligibility/route";
import { listIndexableEventPlanIds } from "../../../lib/data/indexable-plans";
import { seedHeldSeat, seedWebinar } from "./harness-seats";
import { stageSeatOpenedNotices } from "../../../lib/booking/event-waitlist";
import { getOrgMemberCatalog } from "../../../lib/data/org-member-catalog";
import { getOrgMembers } from "../../../lib/data/org-members";
import {
  MembersListResponseSchema,
  membersListQueryFromUrl,
} from "../../../schemas/organizations";

/** The ids a plan list answers with; parsed, so a contract change fails loudly. */
const ListIdsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

async function seedExpert(status: ConsultantVerificationStatus) {
  const host = await seedHost();
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: status },
  });
  return host;
}

async function seedPlans(host: SeededHost, organizationId: string | null) {
  const owner = { consultantProfileId: host.consultantProfileId };
  const [consultation, subscription, webinar] = await Promise.all([
    prisma.consultationPlan.create({
      data: { title: "1:1", price: BigInt(100_000), organizationId, ...owner },
    }),
    prisma.subscriptionPlan.create({
      data: { title: "Plan", price: BigInt(400_000), organizationId, ...owner },
    }),
    prisma.webinarPlan.create({
      data: {
        title: `Webinar ${randomUUID().slice(0, 8)}`,
        price: BigInt(50_000),
        maxParticipants: 20,
        organizationId,
        ...owner,
      },
    }),
  ]);
  return { consultation, subscription, webinar };
}

const viewAs = (host: SeededHost | null) => {
  mockSession.current = host
    ? { id: host.userId, consultantProfileId: host.consultantProfileId }
    : null;
};

async function listedIds(
  list: (req: NextRequest) => Promise<Response>,
  path: string,
  consultantId: string,
): Promise<string[]> {
  const res = await list(
    new NextRequest(`https://x.test${path}?consultantId=${consultantId}`),
  );
  return ListIdsSchema.parse(await res.json()).data.map((p) => p.id);
}

describe("an unverified expert's plans", () => {
  it("are listed by the 1:1 and subscription plan APIs to the expert only", async () => {
    const pending = await seedExpert("PENDING_VERIFICATION");
    const plans = await seedPlans(pending, null);
    const verified = await seedExpert("VERIFIED");
    const shown = await seedPlans(verified, null);

    viewAs(null);
    const id = pending.consultantProfileId;
    expect(
      await listedIds(listConsultationPlans, "/api/plans/consultations", id),
    ).toEqual([]);
    expect(
      await listedIds(listSubscriptionPlans, "/api/plans/subscriptions", id),
    ).toEqual([]);
    expect(
      await listedIds(
        listConsultationPlans,
        "/api/plans/consultations",
        verified.consultantProfileId,
      ),
    ).toEqual([shown.consultation.id]);

    viewAs(pending);
    expect(
      await listedIds(listConsultationPlans, "/api/plans/consultations", id),
    ).toEqual([plans.consultation.id]);
    expect(
      await listedIds(listSubscriptionPlans, "/api/plans/subscriptions", id),
    ).toEqual([plans.subscription.id]);
  }, 30_000);

  it("open on the plan pages for the expert only", async () => {
    const rejected = await seedExpert("REJECTED");
    const plans = await seedPlans(rejected, null);
    const details = await Promise.all([
      fetchConsultationPlanDetail(plans.consultation.id),
      fetchSubscriptionPlanDetail(plans.subscription.id),
      fetchWebinarPlanDetail(plans.webinar.id),
    ]);

    viewAs(null);
    for (const detail of details) {
      expect(await canViewPlanDetail(detail)).toBe(false);
    }
    viewAs(rejected);
    for (const detail of details) {
      expect(await canViewPlanDetail(detail)).toBe(true);
    }
    const verified = await seedPlans(await seedExpert("VERIFIED"), null);
    viewAs(null);
    expect(
      await canViewPlanDetail(
        await fetchConsultationPlanDetail(verified.consultation.id),
      ),
    ).toBe(true);
  }, 30_000);

  it("are left out of /explore/programs", async () => {
    const pendingHost = await seedExpert("PENDING_VERIFICATION");
    const pending = await seedPlans(pendingHost, null);
    const verifiedHost = await seedExpert("VERIFIED");
    const verified = await seedPlans(verifiedHost, null);

    const curated = (await getCuratedPrograms("webinar", "newest", 5)).map(
      (p) => p.id,
    );
    expect(curated).toContain(verified.webinar.id);
    expect(curated).not.toContain(pending.webinar.id);

    viewAs(null);
    const webinars = (host: SeededHost) =>
      listedIds(
        listWebinarPlans,
        "/api/plans/webinars",
        host.consultantProfileId,
      );
    expect(await webinars(pendingHost)).toEqual([]);
    expect(await webinars(verifiedHost)).toEqual([verified.webinar.id]);
  }, 30_000);

  it("are left out of the organisation member catalog", async () => {
    const org = await prisma.organization.create({
      data: { name: "Database tier org", slug: `db-tier-${randomUUID()}` },
    });
    const pending = await seedPlans(
      await seedExpert("PENDING_VERIFICATION"),
      org.id,
    );
    const verified = await seedPlans(await seedExpert("VERIFIED"), org.id);

    const catalog = (await getOrgMemberCatalog(org.id)).map((e) => e.id).sort();

    expect(catalog).toEqual(
      [
        verified.consultation.id,
        verified.subscription.id,
        verified.webinar.id,
      ].sort(),
    );
    expect(catalog).not.toContain(pending.consultation.id);
  }, 30_000);

  it("show as not verified on the organisation's roster, without the raw status", async () => {
    const org = await prisma.organization.create({
      data: { name: "Database tier org", slug: `db-tier-${randomUUID()}` },
    });
    const hosts = await Promise.all([
      seedExpert("PENDING_VERIFICATION"),
      seedExpert("VERIFIED"),
    ]);
    await prisma.membership.createMany({
      data: hosts.map((h) => ({
        userId: h.userId,
        organizationId: org.id,
        role: "EXPERT" as const,
        consultantProfileId: h.consultantProfileId,
      })),
    });

    const roster = await getOrgMembers(
      org.id,
      membersListQueryFromUrl(() => null),
      { canSeePayout: false },
    );

    const verifiedBy = Object.fromEntries(
      roster.members.map((m) => [m.user.id, m.consultantProfile?.isVerified]),
    );
    expect(verifiedBy).toEqual({
      [hosts[0].userId]: false,
      [hosts[1].userId]: true,
    });
    expect(JSON.stringify(roster)).not.toContain("verificationStatus");
    expect(
      MembersListResponseSchema.safeParse({ data: roster.members }).success,
    ).toBe(true);
  }, 30_000);

  it("are not offered by the trial eligibility check, with or without the plan", async () => {
    const rejected = await seedExpert("REJECTED");
    const plan = await prisma.subscriptionPlan.create({
      data: {
        title: "Hidden trial plan",
        price: BigInt(400_000),
        consultantProfileId: rejected.consultantProfileId,
        trialEnabled: true,
        trialDurationMinutes: 30,
        trialPriceInPaise: BigInt(20_000),
      },
    });
    const learner = await seedConsultee();
    viewAs(null);
    mockSession.current = {
      id: learner.userId,
      consulteeProfileId: learner.consulteeProfileId,
      consultantProfileId: null,
      role: "CONSULTEE",
    };
    const check = async (withPlan: boolean) => {
      const query = new URLSearchParams({
        consulteeProfileId: learner.consulteeProfileId,
        consultantProfileId: rejected.consultantProfileId,
        ...(withPlan ? { subscriptionPlanId: plan.id } : {}),
      });
      const res = await checkTrialEligibility(
        new NextRequest(`https://x.test/api/trials/check-eligibility?${query}`),
      );
      return { status: res.status, body: JSON.stringify(await res.json()) };
    };

    const listed = await check(false);
    const named = await check(true);

    expect(listed.body).not.toContain(plan.id);
    expect(listed.body).not.toContain("20000");
    expect(named.status).toBe(404);
    expect(named.body).not.toContain(plan.id);
  }, 30_000);

  it("are left out of the sitemap until the expert is verified", async () => {
    const verified = await seedWebinar({ capacity: 20 });
    const rejected = await seedWebinar({ capacity: 20 });
    await prisma.consultantProfile.update({
      where: { id: rejected.host.consultantProfileId },
      data: { verificationStatus: "REJECTED" },
    });

    const { webinarPlanIds } = await listIndexableEventPlanIds(new Date());

    expect(webinarPlanIds).toContain(verified.planId);
    expect(webinarPlanIds).not.toContain(rejected.planId);
  }, 30_000);

  it("are left out of the /explore/programs headline counts", async () => {
    const before = await getProgramCounts();
    await seedPlans(await seedExpert("PENDING_VERIFICATION"), null);
    await seedPlans(await seedExpert("VERIFIED"), null);
    const archivedHost = await seedExpert("VERIFIED");
    const archived = await seedPlans(archivedHost, null);
    await prisma.webinarPlan.update({
      where: { id: archived.webinar.id },
      data: { archivedAt: new Date() },
    });

    const after = await getProgramCounts();

    expect(after.publishedWebinarCount - before.publishedWebinarCount).toBe(1);
  }, 30_000);

  it("are listed to their owner by the webinar list too, and never from a shared cache", async () => {
    const pending = await seedExpert("PENDING_VERIFICATION");
    const plans = await seedPlans(pending, null);
    const read = async () =>
      listWebinarPlans(
        new NextRequest(
          `https://x.test/api/plans/webinars?consultantId=${pending.consultantProfileId}`,
        ),
      );

    viewAs(pending);
    const own = await read();
    viewAs(null);
    const stranger = await read();

    const ids = async (res: Response) =>
      ListIdsSchema.parse(await res.json()).data.map((p) => p.id);
    expect(await ids(own)).toEqual([plans.webinar.id]);
    expect(await ids(stranger)).toEqual([]);
    expect(own.headers.get("Cache-Control")).toBe("private, no-store");
    expect(stranger.headers.get("Cache-Control")).toBe("private, no-store");
  }, 30_000);

  it("keys the shared 1:1 and subscription lists on every query they read", async () => {
    viewAs(null);
    for (const [list, path] of [
      [listConsultationPlans, "/api/plans/consultations"],
      [listSubscriptionPlans, "/api/plans/subscriptions"],
    ] as const) {
      const res = await list(new NextRequest(`https://x.test${path}?page=2`));
      expect(res.headers.get("Cache-Control")).toMatch(/^public, s-maxage=/);
      expect(res.headers.get("Netlify-Vary")).toBe(
        "query=page|limit|consultantId",
      );
    }
  }, 30_000);

  it("invite no waitlisted learner to buy when a seat opens", async () => {
    const waitingOn = async (rejected: boolean) => {
      const webinar = await seedWebinar({ capacity: 2 });
      await prisma.webinarPlan.update({
        where: { id: webinar.planId },
        data: { waitlistEnabled: true },
      });
      await seedHeldSeat(webinar, { status: "SUCCEEDED", expiresAt: null });
      const waiter = await seedConsultee();
      const row = await prisma.appointmentWaitlist.create({
        data: {
          appointmentId: webinar.appointmentId,
          userId: waiter.userId,
          planKind: "WEBINAR",
          planId: webinar.planId,
        },
      });
      if (rejected) {
        await prisma.consultantProfile.update({
          where: { id: webinar.host.consultantProfileId },
          data: { verificationStatus: "REJECTED" },
        });
      }
      await prisma.$transaction((tx) =>
        stageSeatOpenedNotices(tx, webinar.appointmentId, new Date()),
      );
      return (
        await prisma.appointmentWaitlist.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true },
        })
      ).status;
    };

    expect(await waitingOn(false)).toBe("NOTIFIED");
    expect(await waitingOn(true)).toBe("WAITING");
  }, 30_000);
});
