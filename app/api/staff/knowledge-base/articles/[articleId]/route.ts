/**
 * Staff Knowledge Base Article Detail API
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
 * GET /api/staff/knowledge-base/articles/[articleId]
 * Get article details and increment view count
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
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

    const article = await prisma.knowledgeBaseArticle.findUnique({
      where: { id: articleId },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        author: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    if (!article) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    // Staff can only see published articles
    if (user?.role === UserRole.STAFF && article.status !== "PUBLISHED") {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    // Increment view count
    await prisma.knowledgeBaseArticle.update({
      where: { id: articleId },
      data: { viewCount: { increment: 1 } },
    });

    return NextResponse.json({ article });
  } catch (error) {
    console.error("Error fetching KB article:", error);
    return NextResponse.json(
      { error: "Failed to fetch article" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/staff/knowledge-base/articles/[articleId]
 * Update article (admin only)
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

    const { articleId } = await params;
    const body = await req.json();
    const { title, content, excerpt, categoryId, status, metaTitle, metaDescription } = body;

    const existingArticle = await prisma.knowledgeBaseArticle.findUnique({
      where: { id: articleId },
    });

    if (!existingArticle) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};

    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;
    if (excerpt !== undefined) updateData.excerpt = excerpt;
    if (categoryId !== undefined) updateData.categoryId = categoryId;
    if (metaTitle !== undefined) updateData.metaTitle = metaTitle;
    if (metaDescription !== undefined) updateData.metaDescription = metaDescription;

    if (status !== undefined) {
      updateData.status = status;
      // Set publishedAt when publishing for the first time
      if (status === "PUBLISHED" && !existingArticle.publishedAt) {
        updateData.publishedAt = new Date();
      }
    }

    const article = await prisma.knowledgeBaseArticle.update({
      where: { id: articleId },
      data: updateData,
      include: {
        category: { select: { id: true, name: true } },
        author: { select: { id: true, name: true, email: true } },
      },
    });

    return NextResponse.json({ article });
  } catch (error) {
    console.error("Error updating KB article:", error);
    return NextResponse.json(
      { error: "Failed to update article" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/staff/knowledge-base/articles/[articleId]
 * Delete article (admin only)
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
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

    const { articleId } = await params;

    await prisma.knowledgeBaseArticle.delete({
      where: { id: articleId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting KB article:", error);
    return NextResponse.json(
      { error: "Failed to delete article" },
      { status: 500 }
    );
  }
}
