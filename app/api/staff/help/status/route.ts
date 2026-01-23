/**
 * Staff Help System Status API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/help/status
 * Get current system status for all services
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const services = await prisma.systemStatus.findMany({
      orderBy: { order: "asc" },
    });

    // If no services in DB, return default list
    if (services.length === 0) {
      const defaultServices = [
        { serviceName: "staff-portal", displayName: "Staff Portal", status: "OPERATIONAL" },
        { serviceName: "video-calling", displayName: "Video Calling", status: "OPERATIONAL" },
        { serviceName: "payment-gateway", displayName: "Payment Gateway", status: "OPERATIONAL" },
        { serviceName: "email-services", displayName: "Email Services", status: "OPERATIONAL" },
        { serviceName: "chat-services", displayName: "Chat Services", status: "OPERATIONAL" },
        { serviceName: "storage", displayName: "File Storage", status: "OPERATIONAL" },
      ];

      return NextResponse.json({
        services: defaultServices,
        overallStatus: "OPERATIONAL",
        lastUpdated: new Date(),
      });
    }

    // Determine overall status
    const hasOutage = services.some((s) => s.status === "OUTAGE");
    const hasDegraded = services.some((s) => s.status === "DEGRADED");
    const hasMaintenance = services.some((s) => s.status === "MAINTENANCE");

    let overallStatus = "OPERATIONAL";
    if (hasOutage) overallStatus = "OUTAGE";
    else if (hasDegraded) overallStatus = "DEGRADED";
    else if (hasMaintenance) overallStatus = "MAINTENANCE";

    const formattedServices = services.map((service) => ({
      id: service.id,
      serviceName: service.serviceName,
      displayName: service.displayName,
      status: service.status,
      description: service.description,
      lastIncidentAt: service.lastIncidentAt,
      incidentNote: service.incidentNote,
      updatedAt: service.updatedAt,
    }));

    return NextResponse.json({
      services: formattedServices,
      overallStatus,
      lastUpdated: new Date(),
    });
  } catch (error) {
    console.error("Error fetching system status:", error);
    return NextResponse.json(
      { error: "Failed to fetch system status" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/staff/help/status
 * Initialize default system status entries (admin only)
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const defaultServices = [
      { serviceName: "staff-portal", displayName: "Staff Portal", order: 1 },
      { serviceName: "video-calling", displayName: "Video Calling", order: 2 },
      { serviceName: "payment-gateway", displayName: "Payment Gateway", order: 3 },
      { serviceName: "email-services", displayName: "Email Services", order: 4 },
      { serviceName: "chat-services", displayName: "Chat Services", order: 5 },
      { serviceName: "storage", displayName: "File Storage", order: 6 },
    ];

    const created = await prisma.$transaction(
      defaultServices.map((service) =>
        prisma.systemStatus.upsert({
          where: { serviceName: service.serviceName },
          create: service,
          update: {},
        })
      )
    );

    return NextResponse.json({ services: created }, { status: 201 });
  } catch (error) {
    console.error("Error initializing system status:", error);
    return NextResponse.json(
      { error: "Failed to initialize system status" },
      { status: 500 }
    );
  }
}
