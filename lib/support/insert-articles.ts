import type { ArticleLink } from "@/types/support-case";

const LIMIT = 8;

/**
 * #1527 — the composer Insert menu's Help Center section: the topic's
 * suggested articles while the search is empty, otherwise the titles that
 * contain every word, suggested ones first. Pure.
 */
export function insertMenuArticles(
  suggested: readonly ArticleLink[],
  all: readonly ArticleLink[],
  query: string,
): ArticleLink[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...suggested];
  const seen = new Set<string>();
  return [...suggested, ...all]
    .filter((a) => {
      if (seen.has(a.href)) return false;
      seen.add(a.href);
      const title = a.title.toLowerCase();
      return words.every((w) => title.includes(w));
    })
    .slice(0, LIMIT);
}
