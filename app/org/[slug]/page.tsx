import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Building2, Globe, Users, Star, ExternalLink } from "lucide-react";
import prisma from "@/lib/prisma";
import type { OrganizationKind, OrgMemberStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";

interface OrgPageProps {
  params: Promise<{ slug: string }>;
}

// Prisma query result types
type OrgQueryResult = NonNullable<Awaited<ReturnType<typeof getOrgData>>>;
type ConsultantMember = OrgQueryResult["organizationProfile"] extends { members: (infer M)[] } | null ? M : never;

async function getOrgData(slug: string) {
  return prisma.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      organizationProfile: {
        select: {
          id: true,
          kind: true,
          status: true,
          description: true,
          industry: true,
          website: true,
          logo: true,
          bannerImage: true,
          primaryColor: true,
          secondaryColor: true,
          members: {
            where: { role: "ORG_CONSULTANT", status: "ACTIVE" as OrgMemberStatus },
            include: {
              member: {
                include: {
                  user: {
                    select: { name: true, image: true },
                  },
                },
              },
              consultantProfile: {
                select: {
                  id: true,
                  headline: true,
                  rating: true,
                  isVerified: true,
                  experience: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export default async function PublicOrgPage({ params }: OrgPageProps) {
  const { slug } = await params;
  const org = await getOrgData(slug);

  if (!org?.organizationProfile) notFound();

  const profile = org.organizationProfile;

  if (
    (profile.kind !== "PROVIDER" && profile.kind !== "HYBRID") ||
    profile.status !== "ACTIVE"
  ) {
    notFound();
  }

  const consultants = profile.members;

  return (
    <main className="min-h-screen bg-white">
      {/* Hero Section */}
      <div
        className="relative bg-gradient-to-br from-zinc-900 to-zinc-800 text-white"
        style={
          profile.primaryColor
            ? {
                background: `linear-gradient(135deg, ${profile.primaryColor}, ${profile.secondaryColor || "#1f2937"})`,
              }
            : undefined
        }
      >
        {profile.bannerImage && (
          <Image
            src={profile.bannerImage}
            alt=""
            fill
            className="object-cover opacity-20"
          />
        )}
        <div className="relative max-w-5xl mx-auto px-6 py-16">
          <div className="flex items-start gap-6">
            {(org.logo || profile.logo) && (
              <Image
                src={profile.logo || org.logo || ""}
                alt={org.name}
                width={80}
                height={80}
                className="rounded-xl border-2 border-white/20 bg-white"
              />
            )}
            <div>
              <h1 className="text-3xl font-bold">{org.name}</h1>
              {profile.industry && (
                <Badge variant="secondary" className="mt-2">
                  {profile.industry}
                </Badge>
              )}
              {profile.description && (
                <p className="mt-3 text-white/80 max-w-2xl leading-relaxed">
                  {profile.description}
                </p>
              )}
              <div className="flex items-center gap-6 mt-4 text-sm text-white/70">
                <span className="flex items-center gap-1">
                  <Users className="h-4 w-4" />
                  {consultants.length} consultant
                  {consultants.length !== 1 ? "s" : ""}
                </span>
                {profile.website && (
                  <a
                    href={profile.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 hover:text-white transition-colors"
                  >
                    <Globe className="h-4 w-4" />
                    Website
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Consultant Roster */}
      <div className="max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-xl font-semibold text-zinc-900 mb-6">
          Our Consultants
        </h2>

        {consultants.length === 0 ? (
          <p className="text-zinc-500 text-center py-12">
            No consultants listed yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {consultants.map((member: ConsultantMember) => {
              const cp = member.consultantProfile;
              const user = member.member.user;
              if (!cp) return null;

              return (
                <Link
                  key={cp.id}
                  href={`/explore/experts/${cp.id}`}
                >
                  <Card className="h-full hover:border-zinc-400 transition-colors cursor-pointer">
                    <CardContent className="p-5">
                      <div className="flex items-start gap-3">
                        {user.image ? (
                          <Image
                            src={user.image}
                            alt={user.name || ""}
                            width={48}
                            height={48}
                            className="rounded-full"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-zinc-200 flex items-center justify-center text-zinc-500 font-medium">
                            {(user.name || "?")[0]}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-semibold text-zinc-900 truncate">
                              {user.name}
                            </p>
                            {cp.isVerified && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0"
                              >
                                Verified
                              </Badge>
                            )}
                          </div>
                          {cp.headline && (
                            <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">
                              {cp.headline}
                            </p>
                          )}
                          <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
                            {cp.rating > 0 && (
                              <span className="flex items-center gap-0.5">
                                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                                {cp.rating.toFixed(1)}
                              </span>
                            )}
                            {cp.experience && (
                              <span>
                                {cp.experience} yr
                                {cp.experience !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

        {/* CTA for consultants */}
        <div className="mt-12 text-center">
          <p className="text-zinc-500 text-sm mb-3">
            Are you a consultant? Join this organization.
          </p>
          <Link href={`/explore/companies`}>
            <Button variant="outline" size="sm">
              <Building2 className="h-4 w-4 mr-1.5" />
              Browse all organizations
            </Button>
          </Link>
        </div>
      </div>
    </main>
  );
}

export async function generateMetadata({ params }: OrgPageProps) {
  const { slug } = await params;
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { name: true, organizationProfile: { select: { description: true } } },
  });

  return {
    title: org ? `${org.name} | Familiarise` : "Organization | Familiarise",
    description:
      org?.organizationProfile?.description?.slice(0, 160) ||
      `View ${org?.name || "this organization"}'s consultant team on Familiarise`,
  };
}
