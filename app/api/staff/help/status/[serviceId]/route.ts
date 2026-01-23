/**
 * Staff Help System Status Update API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, SystemServiceStatus } from "@prisma/client";

interface RouteParams {
  params: Promise<{ serviceId: string }>;
}

/**
 * PATCH /api/staff/help/status/[serviceId]
 * Update service status (admin only)
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
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

    const { serviceId } = await params;
    const body = await req.json();
    const { status, description, incidentNote } = body;

    // Validate status
    const validStatuses: SystemServiceStatus[] = [
      "OPERATIONAL",
      "DEGRADED",
      "OUTAGE",
      "MAINTENANCE",
    ];
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};

    if (status !== undefined) {
      updateData.status = status;
      // If setting to non-operational, record incident time
      if (status !== "OPERATIONAL") {
        updateData.lastIncidentAt = new Date();
      }
    }
    if (description !== undefined) updateData.description = description;
    if (incidentNote !== undefined) updateData.incidentNote = incidentNote;

    const service = await prisma.systemStatus.update({
      where: { id: serviceId },
      data: updateData,
    });

    return NextResponse.json({ service });
  } catch (error) {
    console.error("Error updating system status:", error);
    return NextResponse.json(
      { error: "Failed to update system status" },
      { status: 500 }
    );
  }
}
