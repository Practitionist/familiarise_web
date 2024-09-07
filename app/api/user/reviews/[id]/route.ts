import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const review = await prisma.consultantReview.findUnique({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    return NextResponse.json(review, { status: 200 });
  } catch (error) {
    console.error("Error getting review:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();
    const updatedReview = await prisma.consultantReview.update({
      where: { id: params.id },
      data: {
        rating: body.rating,
        reviewDescription: body.reviewDescription,
      },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json(updatedReview, { status: 200 });
  } catch (error) {
    console.error("Error updating review:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.consultantReview.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: "Review deleted successfully" }, { status: 200 });
  } catch (error) {
    console.error("Error deleting review:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}