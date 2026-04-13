/**
 * Public organization profile API.
 *
 * GET /api/organizations/public/[slug]
 *
 * Returns public-facing org data for PROVIDER/HYBRID orgs.
 * No authentication required.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const org = await prisma.organization.findUnique({
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
            where: { role: "ORG_CONSULTANT", status: "ACTIVE" },
            include: {
              member: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                    },
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

  if (!org?.organizationProfile) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  const profile = org.organizationProfile;

  // Only show PROVIDER/HYBRID orgs that are ACTIVE
  if (
    (profile.kind !== "PROVIDER" && profile.kind !== "HYBRID") ||
    profile.status !== "ACTIVE"
  ) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
    },
    profile: {
      description: profile.description,
      industry: profile.industry,
      website: profile.website,
      logo: profile.logo,
      bannerImage: profile.bannerImage,
      primaryColor: profile.primaryColor,
      secondaryColor: profile.secondaryColor,
    },
    consultants: profile.members.map((m: typeof profile.members[number]) => ({
      id: m.consultantProfile?.id,
      name: m.member.user.name,
      image: m.member.user.image,
      headline: m.consultantProfile?.headline,
      rating: m.consultantProfile?.rating,
      isVerified: m.consultantProfile?.isVerified,
      experience: m.consultantProfile?.experience,
    })),
    consultantCount: profile.members.length,
  });
}
