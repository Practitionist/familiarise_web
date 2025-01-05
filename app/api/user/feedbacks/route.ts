import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { getServerSession } from "next-auth";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to access your feedback" },
        { status: 401 },
      );
    }

    const feedbacks = await prisma.feedback.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(feedbacks);
  } catch (error) {
    console.error("Error fetching feedbacks:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while fetching your feedback",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to submit feedback" },
        { status: 401 },
      );
    }

    const body = await req.json();

    const feedback = await prisma.feedback.create({
      data: {
        title: body.title,
        description: body.description,
        rating: body.rating,
        category: body.category,
        user: { connect: { id: session.user.id } },
      },
    });

    return NextResponse.json(feedback, { status: 201 });
  } catch (error) {
    console.error("Error creating feedback:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while submitting your feedback",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
