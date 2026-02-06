import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

async function fetchDomainsAndSubdomains() {
  const domains = await prisma.domain.findMany({
    include: {
      subDomains: {
        select: {
          id: true,
          name: true,
          domainId: true,
        },
      },
    },
  });

  return {
    domains: domains.map((d) => ({ id: d.id, name: d.name })),
    subdomains: domains.flatMap((d) =>
      d.subDomains.map((sd) => ({
        id: sd.id,
        name: sd.name,
        domainId: sd.domainId,
      })),
    ),
  };
}

async function fetchTags() {
  return await prisma.tag.findMany({
    select: {
      id: true,
      name: true,
      domainId: true,
    },
  });
}

async function fetchConsultantMetadata() {
  // Only count verified consultants for public display
  const totalConsultants = await prisma.consultantProfile.count({
    where: { verificationStatus: "VERIFIED" },
  });

  // Get domain breakdown for verified consultants only
  const consultantsByDomain = await prisma.domain.findMany({
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          consultantProfiles: {
            where: { verificationStatus: "VERIFIED" },
          },
        },
      },
    },
  });

  const averageRating = await prisma.consultantProfile.aggregate({
    where: { verificationStatus: "VERIFIED" },
    _avg: { rating: true },
  });

  return {
    totalConsultants,
    consultantsByDomain: consultantsByDomain.map((d) => ({
      id: d.id,
      name: d.name,
      consultantCount: d._count.consultantProfiles,
    })),
    averageRating: averageRating._avg.rating || 0,
  };
}

async function fetchAvailabilityStats() {
  const hasSlots = await prisma.consultantProfile.count({
    where: {
      verificationStatus: "VERIFIED",
      OR: [
        { slotsOfAvailabilityWeekly: { some: {} } },
        { slotsOfAvailabilityCustom: { some: {} } },
      ],
    },
  });

  return { hasSlots };
}

async function fetchAvailableLanguages(): Promise<string[]> {
  const consultants = await prisma.consultantProfile.findMany({
    where: { verificationStatus: "VERIFIED" },
    select: { languages: true },
  });
  const langSet = new Set<string>();
  for (const c of consultants) {
    for (const lang of c.languages) {
      langSet.add(lang);
    }
  }
  return Array.from(langSet).sort();
}

export async function GET(req: NextRequest) {
  try {
    const [
      { domains, subdomains },
      tags,
      consultantMetadata,
      availableLanguages,
      availabilityStats,
    ] = await Promise.all([
      fetchDomainsAndSubdomains(),
      fetchTags(),
      fetchConsultantMetadata(),
      fetchAvailableLanguages(),
      fetchAvailabilityStats(),
    ]);

    return NextResponse.json(
      {
        data: {
          domains,
          subdomains,
          tags,
          consultantMetadata,
          availableLanguages,
          availabilityStats,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error in GET request:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching metadata" },
      { status: 500 },
    );
  }
}
