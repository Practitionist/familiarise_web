/**
 * @jest-environment node
 *
 * Guards the public `/support` content model: categories resolve, slugs are
 * unique, related links point at real articles, and escalation categories
 * stay in sync with the contact form's INQUIRY_CATEGORIES.
 */
import { INQUIRY_CATEGORIES } from "@/app/(pages)/constants";
import {
  articleUrl,
  articlesForCategory,
  getArticle,
  getCategory,
  relatedArticles,
  supportArticles,
  supportCategories,
} from "@/app/support/_data/support-content";

describe("support content model", () => {
  it("has eight categories with unique slugs", () => {
    expect(supportCategories).toHaveLength(8);
    const slugs = supportCategories.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("resolves every article's category and keeps slugs unique per category", () => {
    const seen = new Set<string>();
    for (const article of supportArticles) {
      expect(getCategory(article.category)).toBeDefined();
      const key = `${article.category}/${article.slug}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(getArticle(article.category, article.slug)).toEqual(article);
      expect(articlesForCategory(article.category)).toContain(article);
    }
    expect(supportArticles.length).toBeGreaterThanOrEqual(30);
  });

  it("gives every article a title, excerpt, and at least one section", () => {
    for (const article of supportArticles) {
      expect(article.title.length).toBeGreaterThan(0);
      expect(article.excerpt.length).toBeGreaterThan(0);
      expect(article.sections.length).toBeGreaterThanOrEqual(1);
      for (const section of article.sections) {
        expect(section.heading.length).toBeGreaterThan(0);
        expect(section.paragraphs.length).toBeGreaterThanOrEqual(1);
      }
      expect(articleUrl(article)).toBe(
        `/support/${article.category}/${article.slug}`,
      );
    }
  });

  it("resolves every related-article reference", () => {
    for (const article of supportArticles) {
      // Resolve each raw ref directly: relatedArticles() drops stale entries
      // silently, so only asserting on its output cannot catch a dead link.
      for (const ref of article.related) {
        const [category, ...rest] = ref.split("/");
        expect(getArticle(category, rest.join("/"))).toBeDefined();
      }
      expect(relatedArticles(article)).toHaveLength(article.related.length);
      for (const rel of relatedArticles(article)) {
        expect(supportArticles).toContain(rel);
      }
      // No self-links.
      expect(
        relatedArticles(article).some(
          (r) => r.category === article.category && r.slug === article.slug,
        ),
      ).toBe(false);
    }
  });

  it("uses only valid contact-form categories for escalation", () => {
    // Exclude the "" placeholder ("Select a category"): an article carrying it
    // would render the form un-categorised.
    const valid: Set<string> = new Set(
      INQUIRY_CATEGORIES.map((c) => c.value).filter(Boolean),
    );
    for (const article of supportArticles) {
      expect(valid.has(article.contactCategory)).toBe(true);
    }
  });
});
