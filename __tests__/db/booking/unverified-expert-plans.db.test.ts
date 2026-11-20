/**
 * An expert who is not verified may build and publish plans, but only they see
 * them: the public plan lists, the plan pages, /explore/programs and the
 * organisation member catalog leave them out, each read through its real reader.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { ConsultantVerificationStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { seedHost, type SeededHost } from "./harness";

const mockSession = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () =>
    mockSession.current ? { user: mockSession.current } : null,
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
import { getCuratedPrograms } from "../../../lib/data/explore-programs";
import { getOrgMemberCatalog } from "../../../lib/data/org-member-catalog";
import { getOrgMembers } from "../../../lib/data/org-members";
import {
  MembersListResponseSchema,
  membersListQueryFromUrl,
} from "../../../schemas/organizations";

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
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((p) => p.id);
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
});
