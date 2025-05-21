import * as Sentry from "@sentry/nextjs";
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
  const totalConsultants = await prisma.consultantProfile.count();
  const consultantsByDomain = await prisma.domain.findMany({
    select: {
      id: true,
      name: true,
      _count: {
        select: { consultantProfiles: true },
      },
    },
  });
  const averageRating = await prisma.consultantProfile.aggregate({
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

export async function GET(req: NextRequest) {
  try {
    const [{ domains, subdomains }, tags, consultantMetadata] =
      await Promise.all([
        fetchDomainsAndSubdomains(),
        fetchTags(),
        fetchConsultantMetadata(),
      ]);

    return NextResponse.json(
      {
        data: {
          domains,
          subdomains,
          tags,
          consultantMetadata,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(error);
    console.error("Error in GET request:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching metadata" },
      { status: 500 },
    );
  }
}
