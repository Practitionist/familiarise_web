import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import {
  getArticleByKey,
  getCategory,
} from "@/app/support/_data/support-content";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { readArticleVoteCounts } from "@/lib/support/article-feedback";

/**
 * The support team's read of the Help Center article votes — which articles
 * readers found helpful and which ones they did not. Operator-only: it names
 * the articles that are failing, which is exactly what a reader should not
 * see about the queue they are waiting in.
 *
 * The failures come first: the article support needs to fix is the point of
 * the table, not the one with the most votes.
 */
export async function GET() {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const counts = await readArticleVoteCounts();

    const tallies = counts
      .map((count) => {
        const article = getArticleByKey(count.articleKey);
        const category = article ? getCategory(article.category) : undefined;
        return {
          articleKey: count.articleKey,
          // A vote for an article that has left the corpus is kept, under its
          // raw key, so the row is never silently dropped.
          title: article?.title ?? count.articleKey,
          category: article?.category ?? "",
          categoryTitle: category?.title ?? "Unknown",
          helpful: count.helpful,
          notHelpful: count.notHelpful,
          total: count.total,
        };
      })
      .sort(
        (a, b) =>
          b.notHelpful - a.notHelpful ||
          b.total - a.total ||
          a.articleKey.localeCompare(b.articleKey),
      );

    return NextResponse.json(
      { data: { tallies } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching support article feedback:", error);
    return NextResponse.json(
      { error: "Failed to fetch support article feedback" },
      { status: 500 },
    );
  }
}
