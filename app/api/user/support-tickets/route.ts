import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { getServerSession } from "next-auth";
import authOptions from "../../auth/[...nextauth]/options";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to access your support tickets" },
        { status: 401 },
      );
    }

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        responses: {
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
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to create a support ticket" },
        { status: 401 },
      );
    }

    const body = await req.json();

    const ticket = await prisma.supportTicket.create({
      data: {
        title: body.title,
        description: body.description,
        priority: body.priority,
        category: body.category,
        user: { connect: { id: session.user.id } },
      },
      include: {
        responses: true,
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
      { status: 500 },
    );
  }
}
