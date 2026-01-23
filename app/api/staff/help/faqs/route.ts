/**
 * Staff Help FAQs API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/help/faqs
 * Get all active FAQs
 */
export async function GET(req: NextRequest) {
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

    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { isActive: true };
    if (category) {
      where.category = category;
    }

    const faqs = await prisma.helpFAQ.findMany({
      where,
      orderBy: [{ category: "asc" }, { order: "asc" }],
    });

    // Group by category
    const groupedFaqs = faqs.reduce(
      (acc, faq) => {
        if (!acc[faq.category]) {
          acc[faq.category] = [];
        }
        acc[faq.category].push({
          id: faq.id,
          question: faq.question,
          answer: faq.answer,
        });
        return acc;
      },
      {} as Record<string, { id: string; question: string; answer: string }[]>
    );

    return NextResponse.json({ faqs: groupedFaqs });
  } catch (error) {
    console.error("Error fetching FAQs:", error);
    return NextResponse.json(
      { error: "Failed to fetch FAQs" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/staff/help/faqs
 * Create a new FAQ (admin only)
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

    const body = await req.json();
    const { question, answer, category } = body;

    if (!question || !answer || !category) {
      return NextResponse.json(
        { error: "Question, answer, and category are required" },
        { status: 400 }
      );
    }

    // Get max order for this category
    const maxOrder = await prisma.helpFAQ.aggregate({
      where: { category },
      _max: { order: true },
    });

    const faq = await prisma.helpFAQ.create({
      data: {
        question,
        answer,
        category,
        order: (maxOrder._max.order || 0) + 1,
      },
    });

    return NextResponse.json({ faq }, { status: 201 });
  } catch (error) {
    console.error("Error creating FAQ:", error);
    return NextResponse.json(
      { error: "Failed to create FAQ" },
      { status: 500 }
    );
  }
}
