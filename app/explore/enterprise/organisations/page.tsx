import { Suspense } from "react";
import { Building2, Users, Globe, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import prisma from "@/lib/prisma";

export const revalidate = 60;

async function fetchPublicOrgs(industry?: string) {
  const rows = await prisma.organization.findMany({
    where: {
      isPublic: true,
      canHost: true,
      status: "ACTIVE",
      ...(industry
        ? { brandingProfile: { industry: { equals: industry, mode: "insensitive" } } }
        : {}),
    },
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
      _count: {
        select: {
          memberships: { where: { role: "EXPERT", status: "ACTIVE" } },
        },
      },
    },
    orderBy: { name: "asc" },
    take: 48,
  });
  // Flatten brandingProfile so the card renderer reads org.logo / .industry
  // directly without touching every render site.
  return rows.map((row) => ({
    ...row,
    logo: row.brandingProfile?.logo ?? null,
    bannerImage: row.brandingProfile?.bannerImage ?? null,
    description: row.brandingProfile?.description ?? null,
    industry: row.brandingProfile?.industry ?? null,
    website: row.brandingProfile?.website ?? null,
  }));
}

async function fetchIndustryList() {
  const rows = await prisma.orgBrandingProfile.findMany({
    where: {
      organization: { isPublic: true, canHost: true, status: "ACTIVE" },
      industry: { not: null },
    },
    select: { industry: true },
    distinct: ["industry"],
    orderBy: { industry: "asc" },
  });
  return rows.map((r) => r.industry as string);
}

function OrgCard({
  org,
}: {
  org: Awaited<ReturnType<typeof fetchPublicOrgs>>[number];
}) {
  const capabilityLabel = org.canSponsor && org.canHost ? "Hybrid" : "Host";
  const capabilityClass =
    org.canSponsor && org.canHost
      ? "bg-purple-100 text-purple-700 border-purple-200"
      : "bg-blue-100 text-blue-700 border-blue-200";

  return (
    <Link
      href={`/explore/enterprise/organisations/${org.slug}`}
      className="group flex flex-col bg-white rounded-2xl border border-zinc-200 hover:border-zinc-300 hover:shadow-lg transition-all duration-300 overflow-hidden"
    >
      {/* Banner / header area */}
      <div className="relative h-24 bg-gradient-to-br from-zinc-100 to-zinc-200 overflow-hidden">
        {org.bannerImage && (
          <Image
            src={org.bannerImage}
            alt=""
            fill
            className="object-cover opacity-60"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
      </div>

      <div className="p-5 flex flex-col gap-3 flex-1">
        {/* Logo + name row */}
        <div className="flex items-center gap-3 -mt-10 relative">
          <div className="w-14 h-14 rounded-xl bg-white border-2 border-white shadow-md flex items-center justify-center overflow-hidden flex-shrink-0">
            {org.logo ? (
              <Image
                src={org.logo}
                alt={org.name}
                width={56}
                height={56}
                className="object-contain"
              />
            ) : (
              <Building2 className="w-7 h-7 text-zinc-400" />
            )}
          </div>
          <div className="pt-8 min-w-0">
            <h3 className="font-bold text-zinc-900 group-hover:text-zinc-700 transition-colors truncate">
              {org.name}
            </h3>
            {org.industry && (
              <p className="text-xs text-zinc-500 truncate">{org.industry}</p>
            )}
          </div>
        </div>

        {/* Description */}
        {org.description && (
          <p className="text-sm text-zinc-600 line-clamp-2 leading-relaxed">
            {org.description}
          </p>
        )}

        {/* Footer: badges + expert count */}
        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge
              variant="outline"
              className={`text-[10px] px-2 py-0.5 ${capabilityClass}`}
            >
              {capabilityLabel}
            </Badge>
          </div>
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <Users className="w-3.5 h-3.5" />
            <span>{org._count.memberships} expert{org._count.memberships !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function OrgCardSkeleton() {
  return (
    <div className="flex flex-col bg-white rounded-2xl border border-zinc-200 overflow-hidden animate-pulse">
      <div className="h-24 bg-zinc-100" />
      <div className="p-5 flex flex-col gap-3">
        <div className="flex items-center gap-3 -mt-10">
          <div className="w-14 h-14 rounded-xl bg-zinc-200" />
          <div className="pt-8 flex flex-col gap-1">
            <div className="h-4 w-28 bg-zinc-200 rounded" />
            <div className="h-3 w-20 bg-zinc-100 rounded" />
          </div>
        </div>
        <div className="h-3 bg-zinc-100 rounded w-full" />
        <div className="h-3 bg-zinc-100 rounded w-3/4" />
        <div className="flex justify-between pt-2">
          <div className="h-5 w-14 bg-zinc-100 rounded-full" />
          <div className="h-4 w-16 bg-zinc-100 rounded" />
        </div>
      </div>
    </div>
  );
}

async function OrgsGrid({ industry }: { industry?: string }) {
  const orgs = await fetchPublicOrgs(industry);

  if (orgs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Building2 className="w-12 h-12 text-zinc-300 mb-4" />
        <p className="text-zinc-500 text-lg font-medium">
          {industry ? `No agencies in ${industry} yet` : "No agencies listed yet"}
        </p>
        <p className="text-zinc-400 text-sm mt-1">
          {industry ? (
            <Link href="/explore/enterprise/organisations" className="underline hover:text-zinc-600">
              View all industries
            </Link>
          ) : (
            "Check back soon — organizations can opt in to marketplace discovery from their settings."
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
      {orgs.map((org) => (
        <OrgCard key={org.id} org={org} />
      ))}
    </div>
  );
}

export default async function ExploreOrganisationsPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const { industry } = await searchParams;
  const industries = await fetchIndustryList();

  return (
    <main className="min-h-screen bg-white">
      {/* Hero */}
      <section className="relative pt-32 pb-16 bg-zinc-950 overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
          <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
        </div>
        <div className="absolute inset-0 grid-pattern opacity-20" />

        <div className="max-w-[1400px] mx-auto px-4 md:px-8 relative z-10">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
              <Sparkles className="w-4 h-4 text-white" />
              <span className="text-sm font-medium text-zinc-300">
                Expert Networks & Agencies
              </span>
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
              Explore <span className="silver-text">Organisations</span>
            </h1>
            <p className="text-lg text-zinc-400 max-w-xl mx-auto">
              Discover expert networks, consulting agencies, and learning institutions
              on Familiarise. Book their curated experts directly.
            </p>
          </div>
        </div>
      </section>

      {/* Filters + Grid */}
      <section className="py-10 md:py-16">
        <div className="max-w-[1400px] mx-auto px-4 md:px-8">
          {/* Industry filter chips — Link-based for SSR filtering */}
          {industries.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-8">
              <Link
                href="/explore/enterprise/organisations"
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                  !industry
                    ? "bg-zinc-900 text-white"
                    : "bg-zinc-100 text-zinc-700 border border-zinc-200 hover:bg-zinc-200"
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                All Industries
              </Link>
              {industries.map((ind) => (
                <Link
                  key={ind}
                  href={`/explore/enterprise/organisations?industry=${encodeURIComponent(ind)}`}
                  className={`inline-flex items-center px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                    industry?.toLowerCase() === ind.toLowerCase()
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-700 border border-zinc-200 hover:bg-zinc-200"
                  }`}
                >
                  {ind}
                </Link>
              ))}
            </div>
          )}

          {/* Org Cards Grid */}
          <Suspense
            key={industry ?? "all"}
            fallback={
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <OrgCardSkeleton key={i} />
                ))}
              </div>
            }
          >
            <OrgsGrid industry={industry} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
