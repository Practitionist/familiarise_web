import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/dashboard/Section";
import {
  articleUrl,
  helpCenterFor,
  type HelpCenterAudience,
} from "../_data/support-content";

/**
 * Help & support › Help center (#1527 Q2): the public help centre's articles,
 * filtered to this audience's categories. A server component — the article
 * text stays out of the client bundle; the page passes it in as a slot. It
 * lives beside the help centre because components/ may not import app/.
 */
export function HelpCenterPanel({
  audience,
}: Readonly<{ audience: HelpCenterAudience }>) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Answers from our{" "}
        <Link
          href="/support"
          className="font-medium text-foreground underline underline-offset-4"
        >
          help centre
        </Link>
        . Can&apos;t find yours? Open a request in the Requests tab.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {helpCenterFor(audience).map(({ category, articles }) => (
          <Section
            key={category.slug}
            title={category.title}
            description={category.description}
            variant="card"
          >
            <ul className="space-y-2 text-sm">
              {articles.map((article) => (
                <li key={article.slug}>
                  <Link
                    href={articleUrl(article)}
                    className="inline-flex items-start gap-1 text-foreground underline-offset-4 hover:underline"
                  >
                    {article.title}
                    <ArrowUpRight
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ))}
      </div>
    </div>
  );
}
