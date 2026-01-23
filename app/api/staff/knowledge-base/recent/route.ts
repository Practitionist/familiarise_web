/**
 * Staff Knowledge Base Recent Articles API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/knowledge-base/recent
 * Get recently updated/published articles
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
    const limit = parseInt(searchParams.get("limit") || "5");
    const days = parseInt(searchParams.get("days") || "7");

    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const articles = await prisma.knowledgeBaseArticle.findMany({
      where: {
        status: "PUBLISHED",
        updatedAt: { gte: cutoffDate },
      },
      include: {
        category: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    const formattedArticles = articles.map((article) => ({
      id: article.id,
      title: article.title,
      slug: article.slug,
      category: article.category.name,
      updatedAt: article.updatedAt,
      isNew:
        article.publishedAt &&
        article.publishedAt.getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000,
    }));

    return NextResponse.json({ articles: formattedArticles });
  } catch (error) {
    console.error("Error fetching recent articles:", error);
    return NextResponse.json(
      { error: "Failed to fetch recent articles" },
      { status: 500 }
    );
  }
}
