/**
 * Staff Knowledge Base Article Feedback API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

interface RouteParams {
  params: Promise<{ articleId: string }>;
}

/**
 * POST /api/staff/knowledge-base/articles/[articleId]/feedback
 * Mark article as helpful or not helpful
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
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

    const { articleId } = await params;
    const body = await req.json();
    const { helpful } = body;

    if (typeof helpful !== "boolean") {
      return NextResponse.json(
        { error: "helpful field must be a boolean" },
        { status: 400 }
      );
    }

    const article = await prisma.knowledgeBaseArticle.findUnique({
      where: { id: articleId },
    });

    if (!article) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    // Update the appropriate counter
    const updatedArticle = await prisma.knowledgeBaseArticle.update({
      where: { id: articleId },
      data: helpful
        ? { helpfulCount: { increment: 1 } }
        : { notHelpfulCount: { increment: 1 } },
      select: {
        id: true,
        helpfulCount: true,
        notHelpfulCount: true,
      },
    });

    return NextResponse.json({
      success: true,
      helpfulCount: updatedArticle.helpfulCount,
      notHelpfulCount: updatedArticle.notHelpfulCount,
    });
  } catch (error) {
    console.error("Error submitting article feedback:", error);
    return NextResponse.json(
      { error: "Failed to submit feedback" },
      { status: 500 }
    );
  }
}
