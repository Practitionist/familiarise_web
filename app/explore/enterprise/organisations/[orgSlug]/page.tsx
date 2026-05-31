import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Building2,
  Globe,
  Users,
  BadgeCheck,
  ArrowLeft,
  ExternalLink,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import prisma from "@/lib/prisma";
import type { Metadata } from "next";

export const revalidate = 60;

async function fetchOrgBySlug(slug: string) {
  const row = await prisma.organization.findFirst({
    where: { slug, isPublic: true, canHost: true, status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      slug: true,
      canSponsor: true,
      canHost: true,
      brandingProfile: {
        select: {
          logo: true,
          bannerImage: true,
          description: true,
          industry: true,
          website: true,
        },
      },
      // #778 elegance — the org "catalog" is its org-owned per-type plans
      // (organizationId set on the plan) that are publicly visible. The standalone
      // OrganizationPlan model was collapsed into these (one bookable shape).
      consultationPlans: {
        where: { visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] } },
        select: { id: true, title: true, description: true, price: true, priceCurrency: true },
        take: 6,
      },
      subscriptionPlans: {
        where: { visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] } },
        select: { id: true, title: true, description: true, price: true, priceCurrency: true },
        take: 6,
      },
      webinarPlans: {
        where: { visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] } },
        select: { id: true, title: true, description: true, price: true, priceCurrency: true },
        take: 6,
      },
      classPlans: {
        where: { visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] } },
        select: { id: true, title: true, description: true, price: true, priceCurrency: true },
        take: 6,
      },
      memberships: {
        where: {
          role: "EXPERT",
          status: "ACTIVE",
          consultantProfile: {
            verificationStatus: "VERIFIED",
            isIndependent: false,
          },
        },
        select: {
          consultantProfile: {
            select: {
              id: true,
              headline: true,
              rating: true,
              isVerified: true,
              experience: true,
              user: {
                select: { name: true, image: true, profileDisplayImage: true },
              },
              domain: { select: { name: true } },
            },
          },
        },
        take: 12,
      },
    },
  });
  if (!row) return null;
  // Normalize the four org-owned per-type plan lists into one catalog array,
  // tagged with planType, so the sidebar render is unchanged.
  const organizationPlans = [
    ...row.consultationPlans.map((p) => ({ ...p, planType: "CONSULTATION" as const })),
    ...row.subscriptionPlans.map((p) => ({ ...p, planType: "SUBSCRIPTION" as const })),
    ...row.webinarPlans.map((p) => ({ ...p, planType: "WEBINAR" as const })),
    ...row.classPlans.map((p) => ({ ...p, planType: "CLASS" as const })),
  ].slice(0, 6);
  // Flatten brandingProfile into the org shape so the rest of the page reads
  // org.logo / org.description / etc. directly (avoids touching ~12 read sites).
  return {
    ...row,
    organizationPlans,
    logo: row.brandingProfile?.logo ?? null,
    bannerImage: row.brandingProfile?.bannerImage ?? null,
    description: row.brandingProfile?.description ?? null,
    industry: row.brandingProfile?.industry ?? null,
    website: row.brandingProfile?.website ?? null,
  };
}

type OrgData = NonNullable<Awaited<ReturnType<typeof fetchOrgBySlug>>>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await fetchOrgBySlug(orgSlug);
  if (!org) return { title: "Organisation not found" };
  return {
    title: `${org.name} — Familiarise`,
    description: org.description ?? `Expert network on Familiarise`,
  };
}

function ExpertMiniCard({
  expert,
}: {
  expert: NonNullable<OrgData["memberships"][number]["consultantProfile"]>;
}) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="flex items-center gap-3 p-4 bg-white rounded-xl border border-zinc-200 hover:border-zinc-300 hover:shadow-md transition-all group"
    >
      <div className="relative w-12 h-12 flex-shrink-0">
        <Image
          src={expert.user.profileDisplayImage ?? expert.user.image ?? "/placeholder-user.jpg"}
          alt={expert.user.name}
          fill
          className="rounded-xl object-cover"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="font-semibold text-sm text-zinc-900 group-hover:text-zinc-700 truncate">
            {expert.user.name}
          </p>
          {expert.isVerified && (
            <BadgeCheck className="w-4 h-4 text-blue-500 flex-shrink-0" />
          )}
        </div>
        {expert.headline && (
          <p className="text-xs text-zinc-500 truncate">{expert.headline}</p>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          <div className="flex items-center gap-0.5">
            <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
            <span className="text-xs font-medium text-zinc-700">
              {expert.rating.toFixed(1)}
            </span>
          </div>
          {expert.domain && (
            <span className="text-xs text-zinc-400">{expert.domain.name}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = await fetchOrgBySlug(orgSlug);

  if (!org) notFound();

  const capabilityLabel = org.canSponsor && org.canHost ? "Hybrid" : "Host Agency";
  const capabilityClass =
    org.canSponsor && org.canHost
      ? "bg-purple-100 text-purple-700 border-purple-200"
      : "bg-blue-100 text-blue-700 border-blue-200";

  const exclusiveExperts = org.memberships
    .map((m) => m.consultantProfile)
    .filter(Boolean) as NonNullable<OrgData["memberships"][number]["consultantProfile"]>[];

  return (
    <main className="min-h-screen bg-zinc-50">
      {/* Banner */}
      <div className="relative h-48 md:h-64 bg-gradient-to-br from-zinc-800 to-zinc-900 overflow-hidden">
        {org.bannerImage && (
          <Image
            src={org.bannerImage}
            alt=""
            fill
            className="object-cover opacity-40"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-zinc-900/60" />
      </div>

      <div className="max-w-[1100px] mx-auto px-4 md:px-8">
        {/* Back link */}
        <div className="py-4">
          <Link
            href="/explore/enterprise/organisations"
            className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            All Organisations
          </Link>
        </div>

        {/* Org header card */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 md:p-8 mb-8 -mt-16 relative shadow-sm">
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            {/* Logo */}
            <div className="w-20 h-20 rounded-2xl bg-zinc-100 border-2 border-white shadow-md flex items-center justify-center overflow-hidden flex-shrink-0">
              {org.logo ? (
                <Image
                  src={org.logo}
                  alt={org.name}
                  width={80}
                  height={80}
                  className="object-contain"
                />
              ) : (
                <Building2 className="w-10 h-10 text-zinc-400" />
              )}
            </div>

            {/* Details */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <h1 className="text-2xl md:text-3xl font-bold text-zinc-900">
                  {org.name}
                </h1>
                <Badge
                  variant="outline"
                  className={`text-xs ${capabilityClass}`}
                >
                  {capabilityLabel}
                </Badge>
              </div>

              {org.industry && (
                <p className="text-zinc-500 text-sm mb-3">{org.industry}</p>
              )}

              {org.description && (
                <p className="text-zinc-600 leading-relaxed mb-4 max-w-2xl">
                  {org.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-1.5 text-sm text-zinc-600">
                  <Users className="w-4 h-4 text-zinc-400" />
                  <span>
                    <strong>{exclusiveExperts.length}</strong> exclusive expert
                    {exclusiveExperts.length !== 1 ? "s" : ""}
                  </span>
                </div>
                {org.website && (
                  <a
                    href={org.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    <Globe className="w-4 h-4" />
                    Website
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-16">
          {/* Main: Expert roster */}
          <div className="lg:col-span-2 space-y-6">
            {exclusiveExperts.length > 0 ? (
              <>
                <h2 className="text-xl font-bold text-zinc-900">
                  Exclusive Experts
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {exclusiveExperts.map((expert) => (
                    <ExpertMiniCard key={expert.id} expert={expert} />
                  ))}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center bg-white rounded-2xl border border-zinc-200">
                <Users className="w-10 h-10 text-zinc-300 mb-3" />
                <p className="text-zinc-500">No exclusive experts listed yet</p>
              </div>
            )}
          </div>

          {/* Sidebar: Org plans */}
          <div className="space-y-6">
            {org.organizationPlans.length > 0 && (
              <div className="bg-white rounded-2xl border border-zinc-200 p-5">
                <h2 className="text-base font-bold text-zinc-900 mb-4">
                  Available Programs
                </h2>
                <div className="space-y-3">
                  {org.organizationPlans.map((plan) => (
                    <div
                      key={plan.id}
                      className="p-3 rounded-xl bg-zinc-50 border border-zinc-100"
                    >
                      <p className="text-sm font-semibold text-zinc-900 mb-0.5">
                        {plan.title}
                      </p>
                      {plan.description && (
                        <p className="text-xs text-zinc-500 line-clamp-2">
                          {plan.description}
                        </p>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 capitalize"
                        >
                          {plan.planType.toLowerCase()}
                        </Badge>
                        {plan.price > 0 && (
                          <span className="text-xs font-semibold text-zinc-700">
                            ₹{(plan.price / 100).toLocaleString("en-IN")}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CTA */}
            <div className="bg-zinc-900 rounded-2xl p-5 text-center">
              <Building2 className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
              <p className="text-white font-semibold text-sm mb-1">
                Work with {org.name}
              </p>
              <p className="text-zinc-400 text-xs mb-4">
                Browse their experts and book a session directly.
              </p>
              <Button
                asChild
                className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-medium rounded-xl"
              >
                <Link href={`/explore/enterprise/organisations/${org.slug}#experts`}>
                  Browse Experts
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
