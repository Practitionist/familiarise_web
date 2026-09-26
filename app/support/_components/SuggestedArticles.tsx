import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/dashboard/Section";
import {
  articleUrl,
  suggestedArticlesFor,
  type HelpCenterAudience,
} from "../_data/support-content";

/**
 * Support requests › Suggested articles (#1527): a few Help Center answers
 * beside the request entry point. A server component, so article data stays
 * out of the client bundle; the page passes it in as a slot because
 * components/ may not import app/.
 */
export function SuggestedArticles({
  audience,
}: Readonly<{ audience: HelpCenterAudience }>) {
  return (
    <Section title="Suggested articles" variant="card">
      <ul className="space-y-2 text-sm">
        {suggestedArticlesFor(audience).map((article) => (
          <li key={`${article.category}/${article.slug}`}>
            <Link
              href={articleUrl(article)}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {article.title}
            </Link>
          </li>
        ))}
      </ul>
      <a
        href="/support"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        Browse the Help Center
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </a>
    </Section>
  );
}
