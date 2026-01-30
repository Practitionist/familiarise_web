import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { notifyGeneralAnnouncement } from "@/lib/novu";

/**
 * GET /api/announcements
 * Public endpoint to get active announcements
 */
export async function GET() {
  try {
    const now = new Date();

    const announcements = await prisma.announcement.findMany({
      where: {
        isActive: true,
        OR: [
          { startDate: null, endDate: null },
          { startDate: { lte: now }, endDate: null },
          { startDate: null, endDate: { gte: now } },
          { startDate: { lte: now }, endDate: { gte: now } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    return NextResponse.json({
      success: true,
      data: announcements,
    });
  } catch (error) {
    console.error("Get announcements error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch announcements" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/announcements
 * Create a new announcement (admin/staff only)
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    if (!["STAFF", "ADMIN"].includes(session.user.role)) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const {
      title,
      content,
      isActive = true,
      startDate,
      endDate,
      backgroundColor,
      textColor,
      linkUrl,
      linkText,
    } = body;

    if (!title || !content) {
      return NextResponse.json(
        { success: false, error: "Title and content are required" },
        { status: 400 },
      );
    }

    const announcement = await prisma.announcement.create({
      data: {
        title,
        content,
        isActive,
        startDate:
          startDate && !isNaN(new Date(startDate).getTime())
            ? new Date(startDate)
            : null,
        endDate:
          endDate && !isNaN(new Date(endDate).getTime())
            ? new Date(endDate)
            : null,
        backgroundColor: backgroundColor || "#000000",
        textColor: textColor || "#FFFFFF",
        linkUrl,
        linkText,
        createdBy: session.user.id,
      },
    });

    // Fire-and-forget: broadcast announcement to all users
    void (async () => {
      try {
        const users = await prisma.user.findMany({ select: { id: true } });
        await notifyGeneralAnnouncement(
          users.map((u) => u.id),
          {
            title: announcement.title,
            content: announcement.content,
            linkUrl: announcement.linkUrl || undefined,
            linkText: announcement.linkText || undefined,
          },
        );
      } catch (err) {
        console.error("[Novu] Failed to broadcast announcement:", err);
      }
    })();

    return NextResponse.json({
      success: true,
      data: announcement,
    });
  } catch (error) {
    console.error("Create announcement error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create announcement" },
      { status: 500 },
    );
  }
}
