import prisma from "@/lib/prisma";
import { Prisma, PlanEmailSupport } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;
    const subscriptionPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
        consultantProfile: true,
        subscription: true,
      },
    });

    return NextResponse.json({ data: subscriptionPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 }
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;
    const body = await request.json();

    if (body.durationInMonths && body.durationInMonths <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 }
      );
    }

    if (body.callsPerWeek && body.callsPerWeek <= 0) {
      return NextResponse.json(
        { error: "Calls per week must be a positive number" },
        { status: 400 }
      );
    }

    if (body.videoMeetings && body.videoMeetings <= 0) {
      return NextResponse.json(
        { error: "Video meetings must be a positive number" },
        { status: 400 }
      );
    }

    if (body.emailSupport && !Object.values(PlanEmailSupport).includes(body.emailSupport)) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 }
      );
    }

    const subscriptionPlan = await prisma.subscriptionPlan.update({
      where: { id: subscriptionId },
      data: {
        durationInMonths: body.durationInMonths,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        callsPerWeek: body.callsPerWeek,
        videoMeetings: body.videoMeetings,
        emailSupport: body.emailSupport as PlanEmailSupport,
        consultantProfile: body.consultantProfileId ? {
          connect: { id: body.consultantProfileId },
        } : undefined,
      },
      include: {
        consultantProfile: true,
        subscription: true,
      },
    });

    return NextResponse.json({ data: subscriptionPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 }
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;

    const subscriptionPlan = await prisma.subscriptionPlan.delete({
      where: { id: subscriptionId },
      include: {
        consultantProfile: true,
        subscription: true,
      },
    });

    return NextResponse.json({ data: subscriptionPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 }
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}