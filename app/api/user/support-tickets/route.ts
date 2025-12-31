import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { getServerSession } from "next-auth";
import authOptions from "../../auth/[...nextauth]/options";
import { SupportIssueType, SupportPriority } from "@prisma/client";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to access your support tickets" },
        { status: 401 }
      );
    }

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        responses: {
          where: {
            isInternal: false, // Don't show internal notes to users
          },
          orderBy: {
            createdAt: "asc",
          },
          include: {
            user: {
              select: {
                name: true,
                role: true,
              },
            },
          },
        },
        attachments: {
          orderBy: {
            uploadedAt: "desc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(tickets);
  } catch (error) {
    console.error("Error fetching support tickets:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while fetching your support tickets",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

interface CreateTicketBody {
  title: string;
  description: string;
  priority?: SupportPriority;
  category?: string;
  issueType?: SupportIssueType;
  // Optional entity links
  consultationId?: string;
  subscriptionId?: string;
  paymentId?: string;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to create a support ticket" },
        { status: 401 }
      );
    }

    const body: CreateTicketBody = await req.json();

    // Validate required fields
    if (!body.title || !body.description) {
      return NextResponse.json(
        { error: "Title and description are required" },
        { status: 400 }
      );
    }

    // Validate issueType if provided
    if (
      body.issueType &&
      !Object.values(SupportIssueType).includes(body.issueType)
    ) {
      return NextResponse.json(
        { error: "Invalid issue type" },
        { status: 400 }
      );
    }

    // Validate entity links - ensure they belong to this user
    if (body.consultationId) {
      const consultation = await prisma.consultation.findFirst({
        where: {
          id: body.consultationId,
          requestedBy: {
            userId: session.user.id,
          },
        },
      });
      if (!consultation) {
        return NextResponse.json(
          { error: "Invalid consultation ID" },
          { status: 400 }
        );
      }
    }

    if (body.subscriptionId) {
      const subscription = await prisma.subscription.findFirst({
        where: {
          id: body.subscriptionId,
          requestedBy: {
            userId: session.user.id,
          },
        },
      });
      if (!subscription) {
        return NextResponse.json(
          { error: "Invalid subscription ID" },
          { status: 400 }
        );
      }
    }

    if (body.paymentId) {
      const payment = await prisma.payment.findFirst({
        where: {
          id: body.paymentId,
          userId: session.user.id,
        },
      });
      if (!payment) {
        return NextResponse.json(
          { error: "Invalid payment ID" },
          { status: 400 }
        );
      }
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        title: body.title,
        description: body.description,
        priority: body.priority || "MEDIUM",
        category: body.category,
        issueType: body.issueType,
        consultationId: body.consultationId,
        subscriptionId: body.subscriptionId,
        paymentId: body.paymentId,
        user: { connect: { id: session.user.id } },
      },
      include: {
        responses: true,
        attachments: true,
      },
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (error) {
    console.error("Error creating support ticket:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while creating your support ticket",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
