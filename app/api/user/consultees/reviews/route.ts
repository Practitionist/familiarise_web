import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
    try {
      const { searchParams } = new URL(req.url);
      const rating = searchParams.get('rating');
      const consultantId = searchParams.get('consultantId');
      const consulteeId = searchParams.get('consulteeId');
      const searchTerm = searchParams.get('search');
  
      let whereClause: any = {};
  
      if (rating) {
        whereClause.rating = parseInt(rating);
      }
  
      if (consultantId) {
        whereClause.consultantProfileId = consultantId;
      }
  
      if (consulteeId) {
        whereClause.consulteeProfileId = consulteeId;
      }
  
      if (searchTerm) {
        whereClause.reviewDescription = {
          contains: searchTerm,
          mode: 'insensitive',
        };
      }
  
      const reviews = await prisma.consultantReview.findMany({
        where: whereClause,
        include: {
          consultantProfile: true,
          consulteeProfile: true,
        },
      });
  
      return NextResponse.json(reviews, { status: 200 });
    } catch (error) {
      console.error("Error getting reviews:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const newReview = await prisma.consultantReview.create({
      data: {
        rating: body.rating,
        reviewDescription: body.reviewDescription,
        consultantProfileId: body.consultantProfileId,
        consulteeProfileId: body.consulteeProfileId,
      },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json(newReview, { status: 201 });
  } catch (error) {
    console.error("Error creating review:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}