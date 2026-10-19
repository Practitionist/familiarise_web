import prisma from "@/lib/prisma";

export type ArticleVoteCounts = {
  /** The article's Help Center slug — the key the vote was filed under. */
  articleKey: string;
  helpful: number;
  notHelpful: number;
  total: number;
};

/**
 * How many readers found each Help Center article helpful, and how many did
 * not.
 *
 * Only the COUNTS live here: the article titles and topics are content, and
 * content lives in the Help Center's corpus (app/support/_data). The route
 * that serves the support console joins the two, so this layer stays free of
 * the routing layer.
 *
 * Articles nobody voted on are absent — an empty tally is not a signal, and
 * a list of every article would bury the few that are failing.
 */
export async function readArticleVoteCounts(): Promise<ArticleVoteCounts[]> {
  const rows = await prisma.supportArticleFeedback.groupBy({
    by: ["articleKey", "helpful"],
    _count: { _all: true },
  });

  const counts = new Map<string, { helpful: number; notHelpful: number }>();
  for (const row of rows) {
    const current = counts.get(row.articleKey) ?? { helpful: 0, notHelpful: 0 };
    if (row.helpful) current.helpful += row._count._all;
    else current.notHelpful += row._count._all;
    counts.set(row.articleKey, current);
  }

  return [...counts.entries()].map(([articleKey, { helpful, notHelpful }]) => ({
    articleKey,
    helpful,
    notHelpful,
    total: helpful + notHelpful,
  }));
}
