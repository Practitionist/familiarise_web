import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicBreadcrumb } from "@/components/explore/PublicBreadcrumb";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  getExpertsMetadata,
  getTopExpertsInDomain,
} from "@/lib/data/explore-experts";
import { domainPath, findDomainBySlug } from "@/lib/explore/domain-slug";
import ExpertMiniCard from "../../components/ExpertMiniCard";

// Same cache window as the listing it summarises; the domain list and the
// expert rows are shared data-cache entries, so a profile edit refreshes both.
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

type Params = Promise<{ domain: string }>;

async function loadDomain(slug: string) {
  const metadata = await getExpertsMetadata();
  const domain = findDomainBySlug(metadata.domains, slug);
  if (!domain) return null;
  const count =
    metadata.consultantMetadata.consultantsByDomain.find(
      (entry) => entry.id === domain.id,
    )?.consultantCount ?? 0;
  return { domain, count, domains: metadata.domains };
}

export async function generateMetadata({
  params,
}: Readonly<{ params: Params }>): Promise<Metadata> {
  const { domain: slug } = await params;
  const found = await loadDomain(slug).catch(() => null);
  if (!found) return { robots: { index: false } };
  const { domain, count } = found;
  const title = `${domain.name} experts and mentors | Familiarise`;
  const who = count > 0 ? `${count} interviewed` : "interviewed";
  const description = `Book a session with ${who} ${domain.name.toLowerCase()} experts. Compare ratings, experience and prices.`;
  return {
    title,
    description,
    alternates: { canonical: domainPath(domain.name) },
    openGraph: { title, description, url: domainPath(domain.name) },
  };
}

export default async function ExpertsByFieldPage({
  params,
}: Readonly<{ params: Params }>) {
  const { domain: slug } = await params;
  const found = await loadDomain(slug);
  if (!found) notFound();
  const { domain, count, domains } = found;
  const experts = await getTopExpertsInDomain(domain.id, 12);
  const others = domains.filter((d) => d.id !== domain.id);
  const noun = count === 1 ? "expert" : "experts";
  const countSentence =
    count > 0
      ? `${count} interviewed ${noun} in ${domain.name.toLowerCase()}. `
      : "";

  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${domain.name} experts`,
    url: `${BASE_URL}${domainPath(domain.name)}`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: experts.map((expert, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `${BASE_URL}/explore/experts/${expert.id}`,
        name: expert.user.name ?? undefined,
      })),
    },
  };

  return (
    <div className="w-full">
      <JsonLd data={itemList} />
      <div className="border-b border-border bg-card px-4 py-4 md:px-8 lg:px-12">
        <PublicBreadcrumb
          items={[
            { label: "Experts", href: "/explore/experts" },
            { label: domain.name },
          ]}
        />
      </div>

      <section className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-10 space-y-8">
        <header className="max-w-3xl space-y-3">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            {domain.name} experts and mentors
          </h1>
          <p className="text-muted-foreground">
            {countSentence}
            Compare ratings, experience and prices, then book a session.
          </p>
          <Button asChild>
            <Link href={`/explore/experts?domain=${domain.id}`}>
              Filter all {domain.name.toLowerCase()} experts
            </Link>
          </Button>
        </header>

        {experts.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {experts.map((expert) => (
              <ExpertMiniCard key={expert.id} expert={expert} />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">
            No listed experts in this field yet.
          </p>
        )}

        {others.length > 0 && (
          <nav aria-label="Other fields" className="space-y-2">
            <h2 className="text-sm font-semibold">Other fields</h2>
            <div className="flex flex-wrap gap-2">
              {others.map((other) => (
                <Link
                  key={other.id}
                  href={domainPath(other.name)}
                  className="text-xs px-3 py-1.5 rounded-full bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  {other.name}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </section>
    </div>
  );
}
