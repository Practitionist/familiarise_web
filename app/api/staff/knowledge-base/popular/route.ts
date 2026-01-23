/**
 * Staff Knowledge Base Popular Articles API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/knowledge-base/popular
 * Get most viewed published articles
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

    const articles = await prisma.knowledgeBaseArticle.findMany({
      where: { status: "PUBLISHED" },
      include: {
        category: { select: { id: true, name: true } },
      },
      orderBy: { viewCount: "desc" },
      take: limit,
    });

    const formattedArticles = articles.map((article) => ({
      id: article.id,
      title: article.title,
      slug: article.slug,
      category: article.category.name,
      viewCount: article.viewCount,
      helpfulRatio:
        article.helpfulCount + article.notHelpfulCount > 0
          ? Math.round(
              (article.helpfulCount /
                (article.helpfulCount + article.notHelpfulCount)) *
                100
            ) / 10
          : null,
    }));

    return NextResponse.json({ articles: formattedArticles });
  } catch (error) {
    console.error("Error fetching popular articles:", error);
    return NextResponse.json(
      { error: "Failed to fetch popular articles" },
      { status: 500 }
    );
  }
}
