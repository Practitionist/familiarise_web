import { NextRequest, NextResponse } from "next/server";

import { getArticleByKey } from "@/app/support/_data/support-content";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { requireApiSession } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { applyRateLimit, spamLimiter } from "@/lib/rate-limit";
import {
  SupportArticleFeedbackBody,
  SupportArticleKeyParams,
} from "@/schemas/support";

/**
 * The "was this article helpful?" vote.
 *
 * The vote is filed against a Help Center article (the article's slug is the
 * key) and is SIGNED IN: one row per (article, reader), enforced by a unique
 * constraint, so a reader cannot inflate the tally and the support team can
 * attribute the signal. Re-voting replaces the earlier answer rather than
 * adding a row, so the tally is the readers' current sentiment.
 *
 * The rate limiter is the same one the other support writes use — a vote
 * endpoint that can be hammered is a vote endpoint that lies.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ articleKey: string }> },
) {
  const parsedParams = await parseRouteParams(SupportArticleKeyParams, params, {
    route: "support.article.feedback",
    action: "vote",
  });
  if (!parsedParams.ok) return parsedParams.response;
  const { articleKey } = parsedParams.data;

  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const userId = auth.session.user.id;

    const limited = await applyRateLimit(
      spamLimiter,
      `support-article-feedback:${userId}`,
    );
    if (limited) return limited;

    // A vote for an article that does not exist is not a vote: the key is
    // checked against the corpus so the table cannot be filled with junk.
    const article = getArticleByKey(articleKey);
    if (!article) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message:
          "We could not find that Help Center article — it may have been renamed or removed.",
        context: {
          route: "support.article.feedback",
          action: "vote",
          articleKey,
        },
      });
    }

    const parsedBody = SupportArticleFeedbackBody.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsedBody.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsedBody.error.flatten(),
        context: {
          route: "support.article.feedback",
          action: "vote",
          articleKey,
        },
      });
    }

    const helpful = parsedBody.data.helpful;

    await prisma.supportArticleFeedback.upsert({
      where: { articleKey_userId: { articleKey, userId } },
      create: { articleKey, userId, helpful },
      update: { helpful },
    });

    return NextResponse.json(
      { data: { articleKey, helpful } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: {
        route: "support.article.feedback",
        action: "vote",
        articleKey,
      },
    });
  }
}
